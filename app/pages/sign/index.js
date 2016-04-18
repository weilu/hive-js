'use strict';

var Ractive = require('hive-ractive')
var emitter = require('hive-emitter')
var getWallet = require('hive-wallet').getWallet
var bitcoin = require('bitcoinjs-lib')

module.exports = function(el){
    var ractive = new Ractive({
        el: el,
        template: require('./index.ract').template,
        data: {
        }
    })

    emitter.on('balance-ready', function() {
        var wallet = getWallet();
        var currentAddr = wallet.getNextAddress();
        var addresses = wallet.addresses.slice();
        addresses.push(currentAddr);
        ractive.set('addresses', addresses);
    });

    ractive.on('clear-signature', function() {
        ractive.set('signature', false);
    });

    ractive.on('sign-message', function(event) {
        var address = event.node.childNodes[2].innerHTML;
        var privKey;
        var wallet = getWallet();
        if (address === wallet.getNextAddress()) {
            privKey = wallet.externalAccount.derive(wallet.addresses.length).privKey;
        } else {
            privKey = wallet.getPrivateKeyForAddress(address);
        }
        var message = ractive.get('message');
        var sig = bitcoin.Message.sign(privKey, message).toString('base64');
        ractive.set('signature', sig);
        console.log("bitcoin-cli verifymessage '" +
                    address + "' '" +
                    sig + "' '" +
                    message + "'");
    });

    return ractive
}
