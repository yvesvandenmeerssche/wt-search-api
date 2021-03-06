const { assert } = require('chai');

const { db } = require('../../../../src/config');
const { resetDB } = require('../../../../src/db/indexed');
const byLocation = require('../../../../src/services/indexer/indices/by-location');
const Location = require('../../../../src/db/indexed/models/location');

describe('indices.by-location', () => {
  describe('indexHotel', () => {
    beforeEach(async () => {
      await resetDB();
    });

    it('should create a new Location record with the appropriate data', async () => {
      await byLocation.indexHotel({
        address: '0xdummy',
        data: {
          description: { location: { latitude: 40, longitude: 40 } },
        },
      });
      const data = await db(Location.TABLE).select('hotel_address', 'lat', 'lng');
      assert.deepEqual(data, [{
        'hotel_address': '0xdummy',
        'lat': 40,
        'lng': 40,
      }]);
    });

    it('should overwrite an existing Location record', async () => {
      await Location.upsert('0xdummy', 40, 40);
      await byLocation.indexHotel({
        address: '0xdummy',
        data: {
          description: { location: { latitude: 80, longitude: 80 } },
        },
      });
      const data = await db(Location.TABLE).select('hotel_address', 'lat', 'lng');
      assert.deepEqual(data, [{
        'hotel_address': '0xdummy',
        'lat': 80,
        'lng': 80,
      }]);
    });

    it('should not create anything when hotel has no location', async () => {
      await byLocation.indexHotel({
        address: '0xdummy',
        data: { description: {} },
      });
      const data = await db(Location.TABLE).select('hotel_address', 'lat', 'lng');
      assert.deepEqual(data, []);
    });

    it('should remove the previously created location if no longer applicable', async () => {
      await byLocation.indexHotel({
        address: '0xdummy',
        data: { description: { location: { lat: 10, lng: 10 } } },
      });
      let records = await db(Location.TABLE).select('hotel_address');
      assert.equal(records.length, 1);
      await byLocation.indexHotel({ address: '0xdummy', data: {} });
      records = await db(Location.TABLE).select('hotel_address');
      assert.equal(records.length, 0);
    });
  });

  describe('_convertKilometersToDegrees', () => {
    // These test cases have been created using a map.
    it('should approximately convert kilometers to degrees for short distances', async () => {
      const distances = byLocation._convertKilometersToDegrees(50.386, 14.289, 2);
      let expected = 0.028;
      assert.approximately(distances.lng, expected, expected / 100);
    });

    it('should approximately convert kilometers to degrees for midsized distances', async () => {
      const distances = byLocation._convertKilometersToDegrees(50.386, 14.289, 20);
      let expected = 0.282;
      assert.approximately(distances.lng, expected, expected / 100);
    });

    it('should work well in the southern hemisphere', async () => {
      const distances = byLocation._convertKilometersToDegrees(-50.386, 14.289, 20);
      let expected = 0.282;
      assert.approximately(distances.lng, expected, expected / 10);
    });

    it('should work well in the eastern hemisphere', async () => {
      const distances = byLocation._convertKilometersToDegrees(50.386, -14.289, 20);
      let expected = 0.282;
      assert.approximately(distances.lng, expected, expected / 10);
    });
  });

  describe('_getFilter', () => {
    beforeEach(async () => {
      await resetDB();
    });

    it('should return a working filter representation', async () => {
      const kladno = {
        lat: 50.1426281,
        lng: 14.1131347,
      };
      await Location.upsert('0xberoun', 49.9645147, 14.0650694);
      await Location.upsert('0xpraha', 50.0682006, 14.4180053);
      await Location.upsert('0xberlin', 52.5137886, 13.4202919);

      // Filter out all locations under 30 km from Kladno.
      const filter = byLocation._getFilter(kladno.lat, kladno.lng, 30),
        results = await db(filter.table).where(filter.condition).select('hotel_address');
      assert.deepEqual(results, [
        { 'hotel_address': '0xberoun' },
        { 'hotel_address': '0xpraha' },
      ]);
    });
  });

  describe('_getSorting', () => {
    beforeEach(async () => {
      await resetDB();
    });

    it('should return a working sorting representation', async () => {
      const kladno = {
        lat: 50.1426281,
        lng: 14.1131347,
      };
      await Location.upsert('0xpraha', 50.0682006, 14.4180053);
      await Location.upsert('0xvladivostok', 43.1125328, 131.9291211);
      await Location.upsert('0xparis', 48.8576236, 2.3375003);
      await Location.upsert('0xberlin', 52.5137886, 13.4202919);
      await Location.upsert('0xslany', 50.2317808, 14.0844553);
      await Location.upsert('0xlondon', 51.4973892, 0.1053164);

      // Sort by distance from Kladno.
      const sorting = byLocation._getSorting(kladno.lat, kladno.lng),
        results = await db(sorting.table).select(sorting.select).orderBy(sorting.columnName).select('hotel_address');
      assert.deepEqual(results.map((x) => x.hotel_address), [
        '0xslany',
        '0xpraha',
        '0xberlin',
        '0xparis',
        '0xlondon',
        '0xvladivostok',
      ]);
    });

    it('should allow to compute an approximate distance in kilometers', async () => {
      const kladno = {
        lat: 50.1426281,
        lng: 14.1131347,
      };
      await Location.upsert('0xpraha', 50.0682006, 14.4180053);
      await Location.upsert('0xslany', 50.2317808, 14.0844553);
      await Location.upsert('0xlouny', 50.3536783, 13.8087147);

      // Sort by distance from Kladno.
      const sorting = byLocation._getSorting(kladno.lat, kladno.lng),
        results = await db(sorting.table).select(sorting.select).orderBy(sorting.columnName),
        expectedDistances = [ // Found using online maps.
          10.14, // Slany
          23.26, // Praha
          31.93, // Louny
        ];
      for (let i = 0; i < expectedDistances.length; i++) {
        let delta = sorting.computeScore(results[i][sorting.columnName]) - expectedDistances[i];
        assert.isBelow(Math.abs(delta), 0.2); // Accuracy to 200 meters.
      }
    });
  });

  describe('getFiltering', () => {
    it('should return an array of filters based on the query', async () => {
      const query = {
          filters: [
            { type: 'location', condition: { lat: 10, lng: 10, distance: 2 } },
            { type: 'location', condition: { lat: 11, lng: 11, distance: 12 } },
            { type: 'dummy', condition: { dummy: 'dummy' } },
          ],
        },
        filtering = byLocation.getFiltering(query);
      assert.equal(filtering.length, 2);
      assert.property(filtering[0], 'table');
      assert.property(filtering[0], 'condition');
      assert.property(filtering[1], 'table');
      assert.property(filtering[1], 'condition');
    });

    it('should return return undefined if query contains no location filter', async () => {
      const query = {
        filters: [
          { type: 'dummy', condition: { dummy: 'dummy' } },
        ],
      };
      assert.equal(byLocation.getFiltering(query), undefined);
    });

    it('should return return undefined if query contains filters whatsoever', async () => {
      const query = {};
      assert.equal(byLocation.getFiltering(query), undefined);
    });
  });

  describe('getSorting', () => {
    it('should return a sorting representation based on the query', async () => {
      const query = {
          sorting: { type: 'distance', data: { lat: 10, lng: 10 } },
        },
        sorting = byLocation.getSorting(query);
      assert.property(sorting, 'name');
      assert.property(sorting, 'table');
      assert.property(sorting, 'columnName');
      assert.property(sorting, 'select');
      assert.property(sorting, 'computeScore');
    });

    it('should return undefined if the sorting type is not "location"', async () => {
      const query = {
        sorting: { type: 'dummy', data: {} },
      };
      assert.equal(byLocation.getSorting(query), undefined);
    });

    it('should return undefined if no sorting is specified', async () => {
      const query = {};
      assert.equal(byLocation.getSorting(query), undefined);
    });
  });
});
