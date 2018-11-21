const Queue = require('../queue');
const { Fetcher, FetcherRemoteError } = require('./fetcher');
const HotelModel = require('../../db/permanent/models/hotel');
const subscription = require('../../services/subscription');

class CrawlerError extends Error {}
class CrawlerInitializationError extends CrawlerError {}

class Crawler {
  constructor (options) {
    if (!options.logger || !options.logger.log) {
      throw new CrawlerInitializationError('logger is required in options!');
    }
    this.config = options;
    this.queue = Queue.get();
  }

  logError (err, message) {
    // Distinguish between remote errors (we expect them to
    // happen from time to time, they're part of the business)
    // and unexpected ones (true errors representing flaws in
    // our logic).
    const level = (err instanceof FetcherRemoteError) ? 'warn' : 'error';
    this.config.logger[level](err.message);
  }

  getFetcher () {
    if (!this._fetcher) {
      this._fetcher = new Fetcher(this.config);
    }
    return this._fetcher;
  }

  _fetchHotelPart (hotelAddress, partName) {
    const fetcher = this.getFetcher(),
      methodName = `fetch${partName.charAt(0).toUpperCase() + partName.slice(1)}`;
    this.config.logger.debug(`Fetching ${partName} for ${hotelAddress}`);
    return fetcher[methodName](hotelAddress);
  }

  async _syncHotelPart (hotelAddress, partName) {
    const rawData = await this._fetchHotelPart(hotelAddress, partName);
    this.config.logger.debug(`Saving ${hotelAddress} into database`);
    return {
      rawData: rawData,
      db: await HotelModel.upsert({
        address: hotelAddress,
        partName: partName,
        rawData: rawData,
      }),
    };
  }

  async _handleSubscription (hotelAddress, hotelData) {
    const notificationsUri = hotelData
      .filter((part) => part.partName === 'description')
      .map((part) => part.rawData.notificationsUri)[0];
    if (!notificationsUri) {
      return; // Nothing to do.
    }
    try {
      await subscription.subscribeIfNeeded(notificationsUri, hotelAddress);
    } catch (err) {
      if (err instanceof subscription.RemoteError) {
        this.config.logger.info(`Could not subscribe for notifications: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  async syncAllHotels () {
    // TODO deal with errored ids - although they shouldn't
    // occur here, because it's contacting only on-chain data
    const syncPromises = [];
    try {
      this.config.logger.debug('Fetching hotel list');
      const syncStarted = new Date();
      await this.getFetcher().fetchHotelList({
        onEveryPage: (hotels) => {
          for (let hotelAddress of hotels.addresses) {
            syncPromises.push(
              // For the sake of robustness, ignore individual hotel errors.
              // (The errors are logged within syncHotel already.)
              this.syncHotel(hotelAddress).catch(() => undefined)
            );
          }
        },
      });
      await Promise.all(syncPromises);
      // After all the updates are done, delete obsolete hotels
      // and their parts.
      return this.deleteObsolete(syncStarted);
    } catch (e) {
      this.logError(e, `Fetching hotel list error: ${e.message}`);
      throw e;
    }
  }

  async syncHotel (hotelAddress) {
    if (!hotelAddress) {
      throw new CrawlerError('hotelAddress is required to syncHotel.');
    }
    this.config.logger.debug(`Fetching ${hotelAddress} /meta`);
    try {
      const indexData = await this._syncHotelPart(hotelAddress, 'meta');
      const meta = indexData.rawData;
      const parts = HotelModel.PART_NAMES.filter((p) => {
        return typeof meta[`${p}Uri`] === 'string';
      });
      const hotelPartPromises = [];
      for (let hotelPartName of parts) {
        hotelPartPromises.push((async () => {
          try {
            const rawData = await this._fetchHotelPart(hotelAddress, hotelPartName);
            return {
              rawData: rawData,
              partName: hotelPartName,
            };
          } catch (e) {
            this.logError(e, `Fetching hotel part error: ${hotelAddress}:${hotelPartName} - ${e.message}`);
          }
        })());
      }
      const hotelData = (await Promise.all(hotelPartPromises)).map((part) => {
        if (part && part.rawData) {
          return {
            address: hotelAddress,
            partName: part.partName,
            rawData: part.rawData,
          };
        }
      }).filter((p) => !!p);
      if (hotelData.length !== 0) {
        this.config.logger.debug(`Saving ${hotelAddress} into database`);
        await HotelModel.upsert(hotelData);
        if (this.config.triggerIndexing) {
          this.queue.enqueue({ type: 'indexHotel', payload: { hotelAddress } });
        }
      } else {
        this.config.logger.debug(`No data for ${hotelAddress} available`);
      }
      if (this.config.subscribeForNotifications) {
        await this._handleSubscription(hotelAddress, hotelData);
      }
    } catch (e) {
      this.logError(e, `Fetching hotel error: ${hotelAddress} - ${e.message}`);
      throw e;
    };
  }

  async deleteHotel (hotelAddress) {
    if (!hotelAddress) {
      throw new CrawlerError('hotelAddress is required to deleteHotel.');
    }
    this.config.logger.debug(`Deleting hotel ${hotelAddress} locally.`);
    await HotelModel.delete(hotelAddress);
    if (this.config.triggerIndexing) {
      this.queue.enqueue({ type: 'indexHotel', payload: { hotelAddress } });
    }
  }

  async deleteObsolete (cutoff) {
    const addresses = await HotelModel.deleteObsolete(cutoff);
    for (let hotelAddress of addresses) {
      this.queue.enqueue({ type: 'indexHotel', payload: { hotelAddress } });
    }
  }
}

module.exports = Crawler;
