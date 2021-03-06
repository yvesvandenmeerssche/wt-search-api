const winston = require('winston');
const knex = require('knex');

module.exports = {
  db: knex({
    client: 'sqlite',
    connection: {
      filename: './.dev.sqlite',
    },
    useNullAsDefault: true,
  }),
  logger: winston.createLogger({
    level: 'debug',
    transports: [
      new winston.transports.Console({
        format: winston.format.simple(),
        stderrLevels: ['error'],
      }),
    ],
  }),
  crawlerOpts: {
    timeout: 30000,
    limit: 10,
    triggerIndexing: true,
    subscribeForNotifications: true,
  },
  sync: {
    interval: null,
    initial: false,
  },
};
