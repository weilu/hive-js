'use strict';

var work = require('webworkify')
var worker = work(require('./worker.js'))
var auth = require('./auth')
var db = require('./db')
var emitter = require('hive-emitter')
var crypto = require('crypto')
var AES = require('hive-aes')
var denominations = require('hive-denomination')
var Wallet = require('cb-wallet')
var validateSend = require('./validator')
var rng = require('secure-random').randomBuffer
var bitcoin = require('bitcoinjs-lib')

var wallet = null
var seed = null
var id = null

function createWallet(passphrase, network, callback) {
  var message = passphrase ? 'Decoding seed phrase' : 'Generating'
  emitter.emit('wallet-opening', message)

  var data = {passphrase: passphrase}
  if(!passphrase){
   data.entropy = rng(128 / 8).toString('hex')
  }

  worker.postMessage(data)

  worker.addEventListener('message', function(e) {
    assignSeedAndId(e.data.seed)

    var mnemonic = e.data.mnemonic
    auth.exist(id, function(err, userExists){
      if(err) return callback(err);

      callback(null, {userExists: userExists, mnemonic: mnemonic})
      mnemonic = null
    })
  }, false)

  worker.addEventListener('error', function(e) {
    return callback({message: e.message.replace("Uncaught Error: ", '')})
  })
}

function callbackError(err, callbacks) {
  callbacks.forEach(function(fn) {
    if(fn != null) fn(err)
  })
}

function setPin(pin, network, done, unspentsDone, balanceDone) {
  var callbacks = [done, unspentsDone, balanceDone]
  auth.register(id, pin, function(err, token){
    if(err) return callbackError(err.error, callbacks);

    emitter.emit('wallet-auth', {token: token, pin: pin})

    var encrypted = AES.encrypt(seed, token)
    db.saveEncrypedSeed(id, encrypted, function(err){
      if(err) return callbackError(err.error, callbacks);

      var accounts = getAccountsFromSeed(network)
      initWallet(accounts.externalAccount, accounts.internalAccount, network,
                 done, unspentsDone, balanceDone)
    })
  })
}

function resetPin(callback) {
  db.getCredentials(function(err, credentials){
    if(err) return callback(err);

    auth.resetPin(credentials.id, function() {
      db.deleteCredentials(credentials, function(){
        callback('user_deleted')
      })
    })
  })
}

function disablePin(pin, callback) {
  auth.disablePin(id, pin, callback)
}

function openWalletWithPin(pin, network, done, unspentsDone, balanceDone) {
  var callbacks = [done, unspentsDone, balanceDone]
  db.getCredentials(function(err, credentials){
    if(err) return callbackError(err, callbacks);

    var id = credentials.id
    var encryptedSeed = credentials.seed
    auth.login(id, pin, function(err, token){
      if(err){
        if(err.error === 'user_deleted') {
          return db.deleteCredentials(credentials, function(){
            callbackError(err.error, callbacks);
          })
        }
        return callbackError(err.error, callbacks)
      }

      assignSeedAndId(AES.decrypt(encryptedSeed, token))
      emitter.emit('wallet-auth', {token: token, pin: pin})

      var accounts = getAccountsFromSeed(network)
      initWallet(accounts.externalAccount, accounts.internalAccount, network,
                 done, unspentsDone, balanceDone)
    })
  })
}

function assignSeedAndId(s) {
  seed = s
  id = crypto.createHash('sha256').update(seed).digest('hex')
  emitter.emit('wallet-init', {seed: seed, id: id})
}

function getAccountsFromSeed(networkName, done) {
  emitter.emit('wallet-opening', 'Synchronizing Wallet')

  var network = bitcoin.networks[networkName]
  var accountZero = bitcoin.HDNode.fromSeedHex(seed, network).deriveHardened(0)

  return {
    externalAccount: accountZero.derive(0),
    internalAccount: accountZero.derive(1)
  }
}

function initWallet(externalAccount, internalAccount, networkName, done, unspentsDone, balanceDone){
  var network = bitcoin.networks[networkName]

  wallet = new Wallet(externalAccount, internalAccount, networkName, function(err, w) {
    if(err) return done(err)

    var txObjs = wallet.getTransactionHistory()
    done(null, txObjs.map(function(tx) {
      return parseTx(wallet, tx)
    }))
  }, unspentsDone, balanceDone)

  wallet.denomination = denominations[networkName].default
}

function parseTx(wallet, tx) {
  var id = tx.getId()
  var metadata = wallet.txMetadata[id]
  var network = bitcoin.networks[wallet.networkName]

  var timestamp = metadata.timestamp
  timestamp = timestamp ? timestamp * 1000 : new Date().getTime()

  var node = wallet.txGraph.findNodeById(id)
  var prevOutputs = node.prevNodes.reduce(function(inputs, n) {
    inputs[n.id] = n.tx.outs
    return inputs
  }, {})

  var inputs = tx.ins.map(function(input) {
    var buffer = new Buffer(input.hash)
    Array.prototype.reverse.call(buffer)
    var inputTxId = buffer.toString('hex')

    return prevOutputs[inputTxId][input.index]
  })

  return {
    id: id,
    amount: metadata.value,
    timestamp: timestamp,
    confirmations: metadata.confirmations,
    fee: metadata.fee,
    ins: parseOutputs(inputs, network),
    outs: parseOutputs(tx.outs, network)
  }

  function parseOutputs(outputs, network) {
    return outputs.map(function(output){
      return {
        address: bitcoin.Address.fromOutputScript(output.script, network).toString(),
        amount: output.value
      }
    })
  }
}

function sync(done) {
  initWallet(wallet.externalAccount, wallet.internalAccount, wallet.networkName, done)
}

function getWallet(){
  return wallet
}

function walletExists(callback) {
  db.getCredentials(function(err, doc){
    if(doc) return callback(true);
    return callback(false)
  })
}

function reset(callback){
  db.getCredentials(function(err, credentials){
    if(err) return callback(err);

    db.deleteCredentials(credentials, function(deleteError){
      callback(deleteError)
    })
  })
}

module.exports = {
  openWalletWithPin: openWalletWithPin,
  createWallet: createWallet,
  setPin: setPin,
  resetPin: resetPin,
  disablePin: disablePin,
  getWallet: getWallet,
  walletExists: walletExists,
  reset: reset,
  sync: sync,
  validateSend: validateSend,
  parseTx: parseTx
}
