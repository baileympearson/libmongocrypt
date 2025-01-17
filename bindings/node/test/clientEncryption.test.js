'use strict';
const fs = require('fs');
const expect = require('chai').expect;
const sinon = require('sinon');
const mongodb = require('mongodb');
const BSON = mongodb.BSON;
const MongoClient = mongodb.MongoClient;
const cryptoCallbacks = require('../lib/cryptoCallbacks');
const stateMachine = require('../lib/stateMachine')({ mongodb });
const StateMachine = stateMachine.StateMachine;
const { Binary, EJSON, deserialize } = BSON;

function readHttpResponse(path) {
  let data = fs.readFileSync(path, 'utf8').toString();
  data = data.split('\n').join('\r\n');
  return Buffer.from(data, 'utf8');
}

const ClientEncryption = require('../lib/clientEncryption')({
  mongodb,
  stateMachine
}).ClientEncryption;

class MockClient {
  constructor() {
    this.topology = {
      bson: BSON
    };
  }
}

const requirements = require('./requirements.helper');

describe('ClientEncryption', function () {
  this.timeout(12000);
  let client;

  function throwIfNotNsNotFoundError(err) {
    if (!err.message.match(/ns not found/)) {
      throw err;
    }
  }

  async function setup() {
    client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/test');
    await client.connect();
    try {
      await client.db('client').collection('encryption').drop();
    } catch (err) {
      throwIfNotNsNotFoundError(err);
    }
  }

  function teardown() {
    if (requirements.SKIP_LIVE_TESTS) {
      return Promise.resolve();
    }

    return client.close();
  }

  describe('#constructor', function () {
    context('when mongodb exports BSON (driver >= 4.9.0)', function () {
      context('when a bson option is provided', function () {
        const bson = Object.assign({}, BSON);
        const encrypter = new ClientEncryption(
          {},
          {
            bson: bson,
            keyVaultNamespace: 'client.encryption',
            kmsProviders: {
              local: { key: Buffer.alloc(96) }
            }
          }
        );

        it('uses the bson option', function () {
          expect(encrypter._bson).to.equal(bson);
        });
      });

      context('when a bson option is not provided', function () {
        const encrypter = new ClientEncryption(
          {},
          {
            keyVaultNamespace: 'client.encryption',
            kmsProviders: {
              local: { key: Buffer.alloc(96) }
            }
          }
        );

        it('uses the mongodb exported BSON', function () {
          expect(encrypter._bson).to.equal(BSON);
        });
      });

      it('never uses bson from the topology', function () {
        expect(() => {
          new ClientEncryption(
            {},
            {
              keyVaultNamespace: 'client.encryption',
              kmsProviders: {
                local: { key: Buffer.alloc(96) }
              }
            }
          );
        }).not.to.throw();
      });
    });

    context('when mongodb does not export BSON (driver < 4.9.0)', function () {
      context('when a bson option is provided', function () {
        const bson = Object.assign({}, BSON);
        const encrypter = new ClientEncryption(
          {},
          {
            bson: bson,
            keyVaultNamespace: 'client.encryption',
            kmsProviders: {
              local: { key: Buffer.alloc(96) }
            }
          }
        );

        it('uses the bson option', function () {
          expect(encrypter._bson).to.equal(bson);
        });
      });

      context('when a bson option is not provided', function () {
        const mongoNoBson = { ...mongodb, BSON: undefined };
        const ClientEncryptionNoBson = require('../lib/clientEncryption')({
          mongodb: mongoNoBson,
          stateMachine
        }).ClientEncryption;

        context('when the client has a topology', function () {
          const client = new MockClient();
          const encrypter = new ClientEncryptionNoBson(client, {
            keyVaultNamespace: 'client.encryption',
            kmsProviders: {
              local: { key: Buffer.alloc(96) }
            }
          });

          it('uses the bson on the topology', function () {
            expect(encrypter._bson).to.equal(client.topology.bson);
          });
        });

        context('when the client does not have a topology', function () {
          it('raises an error', function () {
            expect(() => {
              new ClientEncryptionNoBson({}, {});
            }).to.throw(/bson/);
          });
        });
      });
    });
  });

  describe('stubbed stateMachine', function () {
    let sandbox = sinon.createSandbox();

    after(() => sandbox.restore());
    before(() => {
      // stubbed out for AWS unit testing below
      const MOCK_KMS_ENCRYPT_REPLY = readHttpResponse(`${__dirname}/data/kms-encrypt-reply.txt`);
      sandbox.stub(StateMachine.prototype, 'kmsRequest').callsFake(request => {
        request.addResponse(MOCK_KMS_ENCRYPT_REPLY);
        return Promise.resolve();
      });
    });

    beforeEach(function () {
      if (requirements.SKIP_LIVE_TESTS) {
        this.currentTest.skipReason = `requirements.SKIP_LIVE_TESTS=${requirements.SKIP_LIVE_TESTS}`;
        this.test.skip();
        return;
      }

      return setup();
    });

    afterEach(function () {
      return teardown();
    });

    [
      {
        name: 'local',
        kmsProviders: { local: { key: Buffer.alloc(96) } }
      },
      {
        name: 'aws',
        kmsProviders: { aws: { accessKeyId: 'example', secretAccessKey: 'example' } },
        options: { masterKey: { region: 'region', key: 'cmk' } }
      }
    ].forEach(providerTest => {
      it(`should create a data key with the "${providerTest.name}" KMS provider`, async function () {
        const providerName = providerTest.name;
        const encryption = new ClientEncryption(client, {
          keyVaultNamespace: 'client.encryption',
          kmsProviders: providerTest.kmsProviders
        });

        const dataKeyOptions = providerTest.options || {};

        const dataKey = await encryption.createDataKey(providerName, dataKeyOptions);
        expect(dataKey).property('_bsontype', 'Binary');

        const doc = await client.db('client').collection('encryption').findOne({ _id: dataKey });
        expect(doc).to.have.property('masterKey');
        expect(doc.masterKey).property('provider', providerName);
      });

      it(`should create a data key with the "${providerTest.name}" KMS provider (fixed key material)`, async function () {
        const providerName = providerTest.name;
        const encryption = new ClientEncryption(client, {
          keyVaultNamespace: 'client.encryption',
          kmsProviders: providerTest.kmsProviders
        });

        const dataKeyOptions = {
          ...providerTest.options,
          keyMaterial: new BSON.Binary(Buffer.alloc(96))
        };

        const dataKey = await encryption.createDataKey(providerName, dataKeyOptions);
        expect(dataKey).property('_bsontype', 'Binary');

        const doc = await client.db('client').collection('encryption').findOne({ _id: dataKey });
        expect(doc).to.have.property('masterKey');
        expect(doc.masterKey).property('provider', providerName);
      });
    });

    it(`should create a data key with the local KMS provider (fixed key material, fixed key UUID)`, async function () {
      // 'Custom Key Material Test' prose spec test:
      const keyVaultColl = client.db('client').collection('encryption');
      const encryption = new ClientEncryption(client, {
        keyVaultNamespace: 'client.encryption',
        kmsProviders: {
          local: {
            key: 'A'.repeat(128) // the value here is not actually relevant
          }
        }
      });

      const dataKeyOptions = {
        keyMaterial: new BSON.Binary(
          Buffer.from(
            'xPTAjBRG5JiPm+d3fj6XLi2q5DMXUS/f1f+SMAlhhwkhDRL0kr8r9GDLIGTAGlvC+HVjSIgdL+RKwZCvpXSyxTICWSXTUYsWYPyu3IoHbuBZdmw2faM3WhcRIgbMReU5',
            'base64'
          )
        )
      };
      const dataKey = await encryption.createDataKey('local', dataKeyOptions);
      expect(dataKey._bsontype).to.equal('Binary');

      // Remove and re-insert with a fixed UUID to guarantee consistent output
      const doc = (
        await keyVaultColl.findOneAndDelete({ _id: dataKey }, { writeConcern: { w: 'majority' } })
      ).value;
      doc._id = new BSON.Binary(Buffer.alloc(16), 4);
      await keyVaultColl.insertOne(doc, { writeConcern: { w: 'majority' } });

      const encrypted = await encryption.encrypt('test', {
        keyId: doc._id,
        algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic'
      });
      expect(encrypted._bsontype).to.equal('Binary');
      expect(encrypted.toString('base64')).to.equal(
        'AQAAAAAAAAAAAAAAAAAAAAACz0ZOLuuhEYi807ZXTdhbqhLaS2/t9wLifJnnNYwiw79d75QYIZ6M/aYC1h9nCzCjZ7pGUpAuNnkUhnIXM3PjrA=='
      );
    });

    it('should fail to create a data key if keyMaterial is wrong', function (done) {
      const encryption = new ClientEncryption(client, {
        keyVaultNamespace: 'client.encryption',
        kmsProviders: { local: { key: 'A'.repeat(128) } }
      });

      const dataKeyOptions = {
        keyMaterial: new BSON.Binary(Buffer.alloc(97))
      };
      try {
        encryption.createDataKey('local', dataKeyOptions);
        expect.fail('missed exception');
      } catch (err) {
        expect(err.message).to.equal('keyMaterial should have length 96, but has length 97');
        done();
      }
    });

    it('should explicitly encrypt and decrypt with the "local" KMS provider', function (done) {
      const encryption = new ClientEncryption(client, {
        keyVaultNamespace: 'client.encryption',
        kmsProviders: { local: { key: Buffer.alloc(96) } }
      });

      encryption.createDataKey('local', (err, dataKey) => {
        expect(err).to.not.exist;

        const encryptOptions = {
          keyId: dataKey,
          algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic'
        };

        encryption.encrypt('hello', encryptOptions, (err, encrypted) => {
          expect(err).to.not.exist;
          expect(encrypted._bsontype).to.equal('Binary');
          expect(encrypted.sub_type).to.equal(6);

          encryption.decrypt(encrypted, (err, decrypted) => {
            expect(err).to.not.exist;
            expect(decrypted).to.equal('hello');
            done();
          });
        });
      });
    });

    it('should explicitly encrypt and decrypt with the "local" KMS provider (promise)', function () {
      const encryption = new ClientEncryption(client, {
        keyVaultNamespace: 'client.encryption',
        kmsProviders: { local: { key: Buffer.alloc(96) } }
      });

      return encryption
        .createDataKey('local')
        .then(dataKey => {
          const encryptOptions = {
            keyId: dataKey,
            algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic'
          };

          return encryption.encrypt('hello', encryptOptions);
        })
        .then(encrypted => {
          expect(encrypted._bsontype).to.equal('Binary');
          expect(encrypted.sub_type).to.equal(6);

          return encryption.decrypt(encrypted);
        })
        .then(decrypted => {
          expect(decrypted).to.equal('hello');
        });
    });

    it('should explicitly encrypt and decrypt with a re-wrapped local key', function () {
      // Create new ClientEncryption instances to make sure
      // that we are actually using the rewrapped keys and not
      // something that has been cached.
      const newClientEncryption = () =>
        new ClientEncryption(client, {
          keyVaultNamespace: 'client.encryption',
          kmsProviders: { local: { key: 'A'.repeat(128) } }
        });
      let encrypted;

      return newClientEncryption()
        .createDataKey('local')
        .then(dataKey => {
          const encryptOptions = {
            keyId: dataKey,
            algorithm: 'Indexed',
            contentionFactor: 0
          };

          return newClientEncryption().encrypt('hello', encryptOptions);
        })
        .then(_encrypted => {
          encrypted = _encrypted;
          expect(encrypted._bsontype).to.equal('Binary');
          expect(encrypted.sub_type).to.equal(6);
        })
        .then(() => {
          return newClientEncryption().rewrapManyDataKey({});
        })
        .then(rewrapManyDataKeyResult => {
          expect(rewrapManyDataKeyResult.bulkWriteResult.result.nModified).to.equal(1);
          return newClientEncryption().decrypt(encrypted);
        })
        .then(decrypted => {
          expect(decrypted).to.equal('hello');
        });
    });

    it('should not perform updates if no keys match', function () {
      const clientEncryption = new ClientEncryption(client, {
        keyVaultNamespace: 'client.encryption',
        kmsProviders: { local: { key: 'A'.repeat(128) } }
      });

      return clientEncryption.rewrapManyDataKey({ _id: 12345 }).then(rewrapManyDataKeyResult => {
        expect(rewrapManyDataKeyResult.bulkWriteResult).to.equal(undefined);
      });
    });

    it.skip('should explicitly encrypt and decrypt with a re-wrapped local key (explicit session/transaction)', function () {
      const encryption = new ClientEncryption(client, {
        keyVaultNamespace: 'client.encryption',
        kmsProviders: { local: { key: 'A'.repeat(128) } }
      });
      let encrypted;
      let rewrapManyDataKeyResult;

      return encryption
        .createDataKey('local')
        .then(dataKey => {
          const encryptOptions = {
            keyId: dataKey,
            algorithm: 'Indexed',
            contentionFactor: 0
          };

          return encryption.encrypt('hello', encryptOptions);
        })
        .then(_encrypted => {
          encrypted = _encrypted;
        })
        .then(() => {
          // withSession does not forward the callback's return value, hence
          // the slightly awkward 'rewrapManyDataKeyResult' passing here
          return client.withSession(session => {
            return session.withTransaction(() => {
              expect(session.transaction.isStarting).to.equal(true);
              expect(session.transaction.isActive).to.equal(true);
              rewrapManyDataKeyResult = encryption.rewrapManyDataKey(
                {},
                { provider: 'local', session }
              );
              return rewrapManyDataKeyResult.then(() => {
                // Verify that the 'session' argument was actually used
                expect(session.transaction.isStarting).to.equal(false);
                expect(session.transaction.isActive).to.equal(true);
              });
            });
          });
        })
        .then(() => {
          return rewrapManyDataKeyResult;
        })
        .then(rewrapManyDataKeyResult => {
          expect(rewrapManyDataKeyResult.bulkWriteResult.result.nModified).to.equal(1);
          return encryption.decrypt(encrypted);
        })
        .then(decrypted => {
          expect(decrypted).to.equal('hello');
        });
    }).skipReason = 'TODO(DRIVERS-2389): add explicit session support to key management API';

    // TODO(NODE-3371): resolve KMS JSON response does not include string 'Plaintext'. HTTP status=200 error
    it.skip('should explicitly encrypt and decrypt with the "aws" KMS provider', function (done) {
      const encryption = new ClientEncryption(client, {
        keyVaultNamespace: 'client.encryption',
        kmsProviders: { aws: { accessKeyId: 'example', secretAccessKey: 'example' } }
      });

      const dataKeyOptions = {
        masterKey: { region: 'region', key: 'cmk' }
      };

      encryption.createDataKey('aws', dataKeyOptions, (err, dataKey) => {
        expect(err).to.not.exist;

        const encryptOptions = {
          keyId: dataKey,
          algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic'
        };

        encryption.encrypt('hello', encryptOptions, (err, encrypted) => {
          expect(err).to.not.exist;
          expect(encrypted).to.have.property('v');
          expect(encrypted.v._bsontype).to.equal('Binary');
          expect(encrypted.v.sub_type).to.equal(6);

          encryption.decrypt(encrypted, (err, decrypted) => {
            expect(err).to.not.exist;
            expect(decrypted).to.equal('hello');
            done();
          });
        });
      });
    }).skipReason =
      "TODO(NODE-3371): resolve KMS JSON response does not include string 'Plaintext'. HTTP status=200 error";
  });

  describe('ClientEncryptionKeyAltNames', function () {
    const kmsProviders = requirements.awsKmsProviders;
    const dataKeyOptions = requirements.awsDataKeyOptions;
    beforeEach(function () {
      if (requirements.SKIP_AWS_TESTS) {
        this.currentTest.skipReason = `requirements.SKIP_AWS_TESTS=${requirements.SKIP_AWS_TESTS}`;
        this.currentTest.skip();
        return;
      }

      return setup().then(() => {
        this.client = client;
        this.collection = client.db('client').collection('encryption');
        this.encryption = new ClientEncryption(this.client, {
          keyVaultNamespace: 'client.encryption',
          kmsProviders
        });
      });
    });

    afterEach(function () {
      return teardown().then(() => {
        this.encryption = undefined;
        this.collection = undefined;
        this.client = undefined;
      });
    });

    function makeOptions(keyAltNames) {
      expect(dataKeyOptions.masterKey).to.be.an('object');
      expect(dataKeyOptions.masterKey.key).to.be.a('string');
      expect(dataKeyOptions.masterKey.region).to.be.a('string');

      return {
        masterKey: {
          key: dataKeyOptions.masterKey.key,
          region: dataKeyOptions.masterKey.region
        },
        keyAltNames
      };
    }

    describe('errors', function () {
      [42, 'hello', { keyAltNames: 'foobar' }, /foobar/].forEach(val => {
        it(`should fail if typeof keyAltNames = ${typeof val}`, function () {
          const options = makeOptions(val);
          expect(() => this.encryption.createDataKey('aws', options, () => undefined)).to.throw(
            TypeError
          );
        });
      });

      [undefined, null, 42, { keyAltNames: 'foobar' }, ['foobar'], /foobar/].forEach(val => {
        it(`should fail if typeof keyAltNames[x] = ${typeof val}`, function () {
          const options = makeOptions([val]);
          expect(() => this.encryption.createDataKey('aws', options, () => undefined)).to.throw(
            TypeError
          );
        });
      });
    });

    it('should create a key with keyAltNames', function () {
      let dataKey;
      const options = makeOptions(['foobar']);
      return this.encryption
        .createDataKey('aws', options)
        .then(_dataKey => (dataKey = _dataKey))
        .then(() => this.collection.findOne({ keyAltNames: 'foobar' }))
        .then(document => {
          expect(document).to.be.an('object');
          expect(document).to.have.property('keyAltNames').that.includes.members(['foobar']);
          expect(document).to.have.property('_id').that.deep.equals(dataKey);
        });
    });

    it('should create a key with multiple keyAltNames', function () {
      let dataKey;
      return this.encryption
        .createDataKey('aws', makeOptions(['foobar', 'fizzbuzz']))
        .then(_dataKey => (dataKey = _dataKey))
        .then(() =>
          Promise.all([
            this.collection.findOne({ keyAltNames: 'foobar' }),
            this.collection.findOne({ keyAltNames: 'fizzbuzz' })
          ])
        )
        .then(docs => {
          expect(docs).to.have.lengthOf(2);
          const doc1 = docs[0];
          const doc2 = docs[1];
          expect(doc1).to.be.an('object');
          expect(doc2).to.be.an('object');
          expect(doc1)
            .to.have.property('keyAltNames')
            .that.includes.members(['foobar', 'fizzbuzz']);
          expect(doc1).to.have.property('_id').that.deep.equals(dataKey);
          expect(doc2)
            .to.have.property('keyAltNames')
            .that.includes.members(['foobar', 'fizzbuzz']);
          expect(doc2).to.have.property('_id').that.deep.equals(dataKey);
        });
    });

    it('should be able to reference a key with `keyAltName` during encryption', function () {
      let keyId;
      const keyAltName = 'mySpecialKey';
      const algorithm = 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic';

      const valueToEncrypt = 'foobar';

      return this.encryption
        .createDataKey('aws', makeOptions([keyAltName]))
        .then(_dataKey => (keyId = _dataKey))
        .then(() => this.encryption.encrypt(valueToEncrypt, { keyId, algorithm }))
        .then(encryptedValue => {
          return this.encryption
            .encrypt(valueToEncrypt, { keyAltName, algorithm })
            .then(encryptedValue2 => {
              expect(encryptedValue).to.deep.equal(encryptedValue2);
            });
        });
    });
  });

  context('with stubbed key material and fixed random source', function () {
    let sandbox = sinon.createSandbox();

    afterEach(() => {
      sandbox.restore();
    });
    beforeEach(() => {
      const rndData = Buffer.from(
        '\x4d\x06\x95\x64\xf5\xa0\x5e\x9e\x35\x23\xb9\x8f\x57\x5a\xcb\x15',
        'latin1'
      );
      let rndPos = 0;
      sandbox.stub(cryptoCallbacks, 'randomHook').callsFake((buffer, count) => {
        if (rndPos + count > rndData) {
          return new Error('Out of fake random data');
        }
        buffer.set(rndData.subarray(rndPos, rndPos + count));
        rndPos += count;
        return count;
      });

      // stubbed out for AWS unit testing below
      sandbox.stub(StateMachine.prototype, 'fetchKeys').callsFake((client, ns, filter, cb) => {
        filter = deserialize(filter);
        const keyIds = filter.$or[0]._id.$in.map(key => key.toString('hex'));
        const fileNames = keyIds.map(
          keyId => `${__dirname}/../../../test/data/keys/${keyId.toUpperCase()}-local-document.json`
        );
        const contents = fileNames.map(filename => EJSON.parse(fs.readFileSync(filename)));
        cb(null, contents);
      });
    });

    // This exactly matches _test_encrypt_fle2_explicit from the C tests
    it('should explicitly encrypt and decrypt with the "local" KMS provider (FLE2, exact result)', function () {
      const encryption = new ClientEncryption(new MockClient(), {
        keyVaultNamespace: 'client.encryption',
        kmsProviders: { local: { key: Buffer.alloc(96) } }
      });

      const encryptOptions = {
        keyId: new Binary(Buffer.from('ABCDEFAB123498761234123456789012', 'hex'), 4),
        algorithm: 'Unindexed'
      };

      return encryption
        .encrypt('value123', encryptOptions)
        .then(encrypted => {
          expect(encrypted._bsontype).to.equal('Binary');
          expect(encrypted.sub_type).to.equal(6);
          expect(encrypted.toString('base64')).to.equal(
            'BqvN76sSNJh2EjQSNFZ4kBICTQaVZPWgXp41I7mPV1rLFTtw1tXzjcdSEyxpKKqujlko5TeizkB9hHQ009dVY1+fgIiDcefh+eQrm3CkhQ=='
          );

          return encryption.decrypt(encrypted);
        })
        .then(decrypted => {
          expect(decrypted).to.equal('value123');
        });
    });
  });

  describe('encrypt()', function () {
    let clientEncryption;
    let completeOptions;
    let dataKey;

    beforeEach(async function () {
      if (requirements.SKIP_LIVE_TESTS) {
        this.currentTest.skipReason = `requirements.SKIP_LIVE_TESTS=${requirements.SKIP_LIVE_TESTS}`;
        this.test.skip();
        return;
      }

      await setup();
      clientEncryption = new ClientEncryption(client, {
        keyVaultNamespace: 'client.encryption',
        kmsProviders: { local: { key: Buffer.alloc(96) } }
      });

      dataKey = await clientEncryption.createDataKey('local', {
        name: 'local',
        kmsProviders: { local: { key: Buffer.alloc(96) } }
      });

      completeOptions = {
        algorithm: 'RangePreview',
        contentionFactor: 0,
        rangeOptions: {
          sparsity: new BSON.Long(1)
        },
        keyId: dataKey
      };
    });

    afterEach(() => teardown());

    context('when expressionMode is incorrectly provided as an argument', function () {
      it('overrides the provided option with the correct value for expression mode', async function () {
        const optionsWithExpressionMode = { ...completeOptions, expressionMode: true };
        const result = await clientEncryption.encrypt(
          new mongodb.Long(0),
          optionsWithExpressionMode
        );

        expect(result).to.be.instanceof(Binary);
      });
    });
  });

  describe('encryptExpression()', function () {
    let clientEncryption;
    let completeOptions;
    let dataKey;
    const expression = {
      $and: [{ someField: { $gt: 1 } }]
    };

    beforeEach(async function () {
      if (requirements.SKIP_LIVE_TESTS) {
        this.currentTest.skipReason = `requirements.SKIP_LIVE_TESTS=${requirements.SKIP_LIVE_TESTS}`;
        this.test.skip();
        return;
      }

      await setup();
      clientEncryption = new ClientEncryption(client, {
        keyVaultNamespace: 'client.encryption',
        kmsProviders: { local: { key: Buffer.alloc(96) } }
      });

      dataKey = await clientEncryption.createDataKey('local', {
        name: 'local',
        kmsProviders: { local: { key: Buffer.alloc(96) } }
      });

      completeOptions = {
        algorithm: 'RangePreview',
        queryType: 'rangePreview',
        contentionFactor: 0,
        rangeOptions: {
          sparsity: new BSON.Long(1)
        },
        keyId: dataKey
      };
    });

    afterEach(() => teardown());

    it('throws if rangeOptions is not provided', async function () {
      expect(delete completeOptions.rangeOptions).to.be.true;
      const errorOrResult = await clientEncryption
        .encryptExpression(expression, completeOptions)
        .catch(e => e);

      expect(errorOrResult).to.be.instanceof(TypeError);
    });

    it('throws if algorithm is not provided', async function () {
      expect(delete completeOptions.algorithm).to.be.true;
      const errorOrResult = await clientEncryption
        .encryptExpression(expression, completeOptions)
        .catch(e => e);

      expect(errorOrResult).to.be.instanceof(TypeError);
    });

    it(`throws if algorithm does not equal 'rangePreview'`, async function () {
      completeOptions['algorithm'] = 'equality';
      const errorOrResult = await clientEncryption
        .encryptExpression(expression, completeOptions)
        .catch(e => e);

      expect(errorOrResult).to.be.instanceof(TypeError);
    });

    it(`does not throw if algorithm has different casing than 'rangePreview'`, async function () {
      completeOptions['algorithm'] = 'rAnGePrEvIeW';
      const errorOrResult = await clientEncryption
        .encryptExpression(expression, completeOptions)
        .catch(e => e);

      expect(errorOrResult).not.to.be.instanceof(Error);
    });

    context('when expressionMode is incorrectly provided as an argument', function () {
      it('overrides the provided option with the correct value for expression mode', async function () {
        const optionsWithExpressionMode = { ...completeOptions, expressionMode: false };
        const result = await clientEncryption.encryptExpression(
          expression,
          optionsWithExpressionMode
        );

        expect(result).not.to.be.instanceof(Binary);
      });
    });
  });

  it('should provide the libmongocrypt version', function () {
    expect(ClientEncryption.libmongocryptVersion).to.be.a('string');
  });
});
