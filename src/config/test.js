const winston = require('winston');
const knex = require('knex');

module.exports = {
  port: 1919,
  readApiUrl: 'http://test-read-api.wt.com',
  db: knex({
    client: 'sqlite3',
    connection: {
      filename: './.test.sqlite',
    },
    useNullAsDefault: true,
  }),
  logger: winston.createLogger({
    level: 'error',
    transports: [
      new winston.transports.Console({
        format: winston.format.simple(),
        stderrLevels: ['error'],
      }),
    ],
  }),
  sync: {
    interval: null,
    initial: false,
  },
};
