const path = require('node:path');
module.exports = { apps: [{
  name: 'sw-interknot',
  cwd: path.join(__dirname, 'server'),
  script: 'index.mjs',
  node_args: '--env-file-if-exists=../.env',
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  max_memory_restart: '768M',
  env: { NODE_ENV: 'production' },
}] };
