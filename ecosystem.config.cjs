const path = require("path");

const repoRoot = __dirname;
const logsDir  = path.join(repoRoot, "logs");

module.exports = {
  apps: [
    {
      name: "sigma-capital",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",

      // Restart policy
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "512M",

      // Log rotation — logs/ is gitignored
      out_file:        path.join(logsDir, "sigma-capital.out.log"),
      error_file:      path.join(logsDir, "sigma-capital.err.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      time: true,

      env: {
        NODE_ENV: "production",
        DRY_RUN: "true",  // override in .env before go-live
      },
    },
  ],
};