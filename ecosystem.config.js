module.exports = {
  apps: [
    {
      name: 'nclex-bot',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: './logs/bot-error.log',
      out_file: './logs/bot-out.log',
      log_file: './logs/bot-combined.log',
      time: true
    },
    {
      name: 'nport-tunnel',
      script: 'nport',
      args: '3000 -s my-nclex-bot',
      instances: 1,
      exec_mode: 'fork',
      restart_delay: 5000,
      error_file: './logs/tunnel-error.log',
      out_file: './logs/tunnel-out.log',
      time: true
    }
  ]
};