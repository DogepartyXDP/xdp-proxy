#!/usr/bin/env node

require('dotenv').config({ path: process.env.SECRETS_PATH || './' })
const http = require('http')
const net = require('net')
const { URL } = require('url')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const WebSocket = require('ws')
const expressWs = require('express-ws')
const zmq = require('zeromq')
const session = require('express-session')
const redis = require('redis')
const jayson = require('jayson/promise')
//const mariadb = require('mariadb')
const yargs = require('yargs/yargs')

const HTTP_PORT = parseInt(process.env.HTTP_PORT || 8095)
const ADDRINDEXRS_URL = new URL(process.env.ADDRINDEXRS_URL || 'tcp://localhost:8435')
const DOGEPARTY_URL = process.env.DOGEPARTY_URL || 'http://rpc:rpc@localhost:4005'
const DOGECOIN_ZMQ_URL = process.env.DOGECOIN_ZMQ_URL || 'tcp://localhost:28835'
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/8'
const DEFAULT_SESSION_SECRET = 'configure this!'
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET

const INTERVAL_CHECK_DOGEPARTY_PARSED = parseInt(process.env.INTERVAL_CHECK_DOGEPARTY_PARSED || '10000')
const INTERVAL_CHECK_DOGEPARTY_MEMPOOL = parseInt(process.env.INTERVAL_CHECK_DOGEPARTY_MEMPOOL || '10000')

var localMempool = [] //To detect new mempool txs on dogeparty
var firstMempoolCheck = true

var localLastBlock = -1

const xdpClient = jayson.client.http(DOGEPARTY_URL)

async function startZmq(notifiers) {
  const sock = new zmq.Subscriber

  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  sock.connect(DOGECOIN_ZMQ_URL)
  if (notifiers && notifiers.hashtx) {
    sock.subscribe('hashtx')
  }

  if (notifiers && notifiers.hashblock) {
    sock.subscribe('hashblock')
  }
  console.log(`ZMQ connected to ${DOGECOIN_ZMQ_URL}`)

  for await (const [topic, msg] of sock) {
    const topicName = topic.toString('utf8')

    if (topicName === 'hashtx') {
      const txid = msg.toString('hex')
      notifiers.hashtx(txid)
    } else if (topicName === 'hashblock') {
      const blockhash = msg.toString('hex')
      notifiers.hashblock(blockhash)
      if (notifiers.xdp) {
        setTimeout(waitForDogepartyBlock(blockhash), INTERVAL_CHECK_DOGEPARTY_PARSED)
      }
    }
  }
}


async function waitForDogepartyBlock(notifiers) {
  let found = false
  let xdpInfo = await xdpClient.request('get_running_info', [])
  let newLastBlock = -1
  
  if (xdpInfo.result && xdpInfo.result.last_block && xdpInfo.result.last_block.block_index) {
    newLastBlock = xdpInfo.result.last_block.block_index    
         
    if ((localLastBlock >= 0) && (newLastBlock >= 0) && (localLastBlock < newLastBlock)){
      let blockIndexes = []
      for (var i = localLastBlock+1;i<=newLastBlock;i++){
        blockIndexes.push(i)
      }
      
      let blocks = await xdpClient.request('get_blocks', {block_indexes: blockIndexes})
      let blockMessages = []
    
      for (var nextBlockIndex in blocks.result){
        var nextBlock = blocks.result[nextBlockIndex]
          
        let nextBlockMessages = nextBlock._messages.map(x => {
          try {
            return {
              ...x,
              bindings: JSON.parse(x.bindings)
            }
          } catch(e) {
            return x
          }
        })

        
        blockMessages.push(...nextBlockMessages)          
      }
    
      if (blockMessages.length > 0){
        notifiers.xdp(blockMessages)
      }
      
      localLastBlock = newLastBlock   
    } else {
      localLastBlock = newLastBlock   
    }
  }  
}

async function waitForMempool(notifiers){
  let found = false
  let xdpMempool
  while (!found) {
    xdpMempoolRequest = await xdpClient.request('get_mempool', [])
    if (xdpMempoolRequest.result) {
      found = true
      xdpMempool = xdpMempoolRequest.result
    } else {
      await sleep(INTERVAL_CHECK_DOGEPARTY_MEMPOOL)
    }
  }

  //First, checks for txs in local mempool that are not longer in dogeparty mempool and remove them
  var nextMempoolTxIndex = 0
  while (nextMempoolTxIndex < localMempool.length){
    var nextMempoolTx = localMempool[nextMempoolTxIndex]
  
    let index = findMempoolTx(nextMempoolTx.tx_hash, localMempool)
    
    if (index == -1){
        localMempool.splice(nextMempoolTxIndex, 1)
      } else {
        nextMempoolTxIndex++
    }       
  }

  //Now checks for new txs in dogeparty mempool
  var newMempoolTxs = []
  for (var nextMempoolTxIndex in xdpMempool){
      var nextMempoolTx = xdpMempool[nextMempoolTxIndex]
    
      let index = findMempoolTx(nextMempoolTx.tx_hash, localMempool)
    
    if (index == -1){
        localMempool.push(nextMempoolTx)
        newMempoolTxs.push(nextMempoolTx)
    }
  }

  if (!firstMempoolCheck){
      if (newMempoolTxs.length > 0){
        notifiers.xdp(newMempoolTxs.map(x => {
          try {
            return {
              ...x,
              bindings: JSON.parse(x.bindings)
            }
          } catch(e) {
            return x
          }
        }))
      } 
  } else {
    firstMempoolCheck = false
  }
  
}

function findMempoolTx(txHash, mempoolArray){
    //TODO: binary search
    for (var nextMempoolTxIndex in mempoolArray){
        var nextMempoolTx = mempoolArray[nextMempoolTxIndex]
        
        if (nextMempoolTx.tx_hash == txHash){
            return nextMempoolTxIndex
        }
        
    }
    
    return -1
}

async function checkParsedBlocks(notifiers){
    await waitForDogepartyBlock(notifiers)
    setTimeout(()=>{checkParsedBlocks(notifiers)}, INTERVAL_CHECK_DOGEPARTY_PARSED)
}

async function checkXcpMempool(notifiers){
    await waitForMempool(notifiers)
    setTimeout(()=>{checkXcpMempool(notifiers)}, INTERVAL_CHECK_DOGEPARTY_MEMPOOL)
}

function startServer() {
  const app = express()
  const redisClient = redis.createClient(REDIS_URL)
  const RedisStore = require('connect-redis')(session)
  //const server = http.createServer(app)
  const wsInstance = expressWs(app)
  if (process.env.HELMET_ON) {
    app.use(helmet()) // Protect headers
  }
  app.use(cors()) // Allow cors
  app.use(
    session({
      store: new RedisStore({ client: redisClient }),
      secret: SESSION_SECRET,
      resave: false,
    })
  )
  app.use(express.static('static'))

  app.get('/api', (req, res) => {
    res.json({})
  })

  const notificationObservers = {
    hashtx: [],
    hashblock: [],
    xdp: []
  }
  const notifiers = {
    hashtx: (data) => {
      //notificationObservers.hashtx.forEach(x => x(data))
    },
    hashblock: (data) => {
      //notificationObservers.hashblock.forEach(x => x(data))
    },
    xdp: (data) => {
      notificationObservers.xdp.forEach(x => x(data))
    }
  }
  //const wss = new WebSocket.Server({ clientTracking: false, noServer: true })
  //server.on('upgrade', function (request, socket, head) {

    /*sessionParser(request, {}, () => {
      // Use this code to allow only api calls that are authed
      if (!request.session.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      console.log('Session is parsed!');

      wss.handleUpgrade(request, socket, head, function (ws) {
        wss.emit('connection', ws, request);
      });
    });*/

  /*  console.log('User asking upgrade to websocket')
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })

  })*/

  let globalId = 0
  //const clients = {}
  app.ws('/', (ws, request) => {
    const myId = globalId++
    console.log(`User ${myId} connected`)
    //const userId = request.session.userId;
    //clients[myId] = ws

    ws.on('message', (message) => {
      // no need for these rn
    })

    ws.on('close', () => {
      //delete clients[myId]
    })
  })

  const broadcast = (msg) => {
    wsInstance.getWss().clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg)
      }
    })
  }

  notificationObservers.hashblock.push((data) => {
    broadcast(JSON.stringify({ hashblock: data }))
  })

  notificationObservers.hashtx.push((data) => {
    broadcast(JSON.stringify({ hashtx: data }))
  })

  notificationObservers.xdp.push((data) => {
    broadcast(JSON.stringify({ xdp: data }))
  })

  //server.listen(HTTP_PORT, (err) => {
  app.listen(HTTP_PORT, (err) => {
    if (err) {
      console.log(`Error while listening on port ${HTTP_PORT}`, err)
    } else {
      console.log(`Listening on port ${HTTP_PORT}`)

      //setImmediate(() => startZmq(notifiers))
      setImmediate(() => checkParsedBlocks(notifiers))
      setImmediate(() => checkXcpMempool(notifiers))
    }
  })

  if (SESSION_SECRET === DEFAULT_SESSION_SECRET) {
    console.error(`Using default session secret "${DEFAULT_SESSION_SECRET}", This is very dangerous: pass SESSION_SECRET environment variable to modify it`)
  }
}

// Yargs has built in mechanism to handle commands, but it isn't working here
const {argv} = yargs(yargs.hideBin(process.argv))
if (argv._.length > 0 && argv._[0] === 'server') {
  startServer()
}
