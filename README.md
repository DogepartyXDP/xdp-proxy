# Description
`xdp-proxy` is a websockets proxy for all the [Dogeparty](https://dogeparty.net) subsystems.

Forked from `xcp-proxy` [repo](https://github.com/DogepartyXCP/xcp-proxy)

# Installation
For a simple Docker-based install of the Dogeparty software stack, see [this guide](https://dogeparty.net/dogenode/).

Manual installation can be done by:

```bash
git clone https://github.com/DogepartyXDP/xdp-proxy
cd xdp-proxy
npm install
npm start
```

The server expects several environment variables to point at the respective backend servers.

The available environment variables along with their defaults are:

```bash
SECRETS_PATH=./
HTTP_PORT=8095
ADDRINDEXRS_URL=tcp://localhost:8435
DOGEPARTY_URL=http://rpc:rpc@localhost:4005
DOGECOIN_ZMQ_URL=tcp://localhost:28835
REDIS_URL=redis://localhost:6379/8
SESSION_SECRET=configure this!
INTERVAL_CHECK_DOGEPARTY_PARSED=1000
```

You can include them in a `secrets` file and point it by setting the SECRETS_PATH
environment variable to it.

# License
Read LICENSE
