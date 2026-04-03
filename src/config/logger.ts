export const loggerConfig = {
  development: {
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
        colorize: true,
      },
    },
    level: 'debug',
  },
  production: {
    level: 'info',
    // Redact sensitive keys from being logged accidentally
    redact: [
      'req.headers.authorization',
      'req.body.password',
      'req.body.refreshToken',
      'res.headers["set-cookie"]',
    ],
  },
  test: false, // Disable logging during tests to keep console clean
};
