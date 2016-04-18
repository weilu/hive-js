'use strict';

var Ractive = require('hive-ractive')
var emitter = require('hive-emitter')
var getWallet = require('hive-wallet').getWallet

module.exports = function(el){
    var ractive = new Ractive({
        el: el,
        template: require('./index.ract').template,
        data: {
        }
    })

    emitter.on('balance-ready', function() {
        var wallet = getWallet();
        console.log(wallet);
        var currentAddr = wallet.getNextAddress();
        var addresses = wallet.addresses.slice();
        addresses.push(currentAddr);

        ractive.set('addresses', addresses);
    });

    return ractive
}
