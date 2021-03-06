const { logger } = require('../../config');
const Hotel = require('../../db/permanent/models/hotel');
const Indexer = require('./index');
const worker = require('../queue/worker');

const indexer = new Indexer();

async function indexHotel (payload) {
  const hotelAddress = payload.hotelAddress;
  logger.debug(`Indexing hotel ${hotelAddress}`);
  const hotel = await Hotel.getHotelData(hotelAddress);
  await indexer.indexHotel(hotel);
};

const registerProcessors = () => {
  worker.register('indexHotel', (data) => {
    return indexHotel(data);
  });
};

module.exports = {
  indexHotel,
  registerProcessors,
};
