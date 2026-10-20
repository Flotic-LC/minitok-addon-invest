module.exports = {
  apps: [
    {
      name: "tossinvest-bot",
      script: "./runner.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        TZ: "Asia/Seoul",
        NODE_ENV: "production",
      },
      // Korean market hours: Mon-Fri 08:50 ~ 15:35 KST
      // Adjust cron_restart if you want the process to fully restart daily
      cron_restart: "35 15 * * 1-5",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      merge_logs: true,
      kill_timeout: 10000,
    },
  ],
};
