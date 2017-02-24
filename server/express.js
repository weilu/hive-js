"use strict"

var express = require('express')
var bodyParser = require('body-parser')
var cookieParser = require('cookie-parser')
var cookieSession = require('cookie-session')
var compress = require('compression')
var path = require('path')
var auth = require('./auth')
var geo = require('./geo')
var validatePin = require('hive-pin-validator')
var crypto = require('crypto')
var helmet = require('helmet')
var parseUrl = require('url').parse;
var https = require('https');

module.exports = function (){
    var app = express()

    app.use(requireHTTPS)

    if(isProduction()){
        app.set('trust proxy', true)
        app.use(helmet.csp({
            'default-src': ["'self'"],
            'child-src': ["'self'", "blob:"],
            'connect-src': [
                "'self'", "blob:",
                'api.bitcoinaverage.com', 'chain.so', // tickers
                'btc.blockr.io', 'tbtc.blockr.io', 'ltc.blockr.io', // blockchain APIs
            ],
            'font-src': ['s3.amazonaws.com'],
            'img-src': ["'self'", 'data:', 'www.gravatar.com'],
            'style-src': ["'self'", 's3.amazonaws.com'],
            // http://lists.w3.org/Archives/Public/public-webappsec/2014Apr/0021.html,
            // https://github.com/ractivejs/ractive/issues/285
            'script-src': ["'self'", 'blob:', "'unsafe-eval'"],
            reportOnly: false,
            setAllHeaders: false,
            safari5: true
        }))
        app.use(helmet.xssFilter())
        app.use(helmet.nosniff())
        app.use(helmet.xframe('sameorigin'))

        var hundredEightyDaysInMilliseconds = 180 * 24 * 60 * 60 * 1000
        app.use(helmet.hsts({
            maxAge: hundredEightyDaysInMilliseconds,
            includeSubdomains: true
        }))
    }

    var anHour = 1000*60*60
    app.use(bodyParser())
    app.use(cookieParser(process.env.COOKIE_SALT))
    app.use(cookieSession({
        signed: false,
        overwrite: false,
        maxAge: anHour,
        httpOnly: true,
        secure: isProduction()
    }))
    app.use(compress())

    var cacheControl = isProduction() ? { maxAge: anHour } : null
    app.use(express.static(path.join(__dirname, '..', 'build'), cacheControl))

    app.get('/proxy', function (req, res) {
        var rqst = https.get(req.query.url, function(resp) {
            resp.pipe(res);
        });
        rqst.on('error', function(err) {
            res.status(500);
            res.json(err);
        });
    });

    app.post('/proxy', function (req, res) {
        var url = parseUrl(req.query.url);
        url.method = 'POST';
        var rqst = https.request(url, function(resp) {
            resp.pipe(res);
        });
        rqst.on('error', function(err) {
            res.status(500);
            res.json(err);
        });
        rqst.write(JSON.stringify(req.body));
        rqst.end();
    });

    app.post('/register', validateAuthParams(false), function(req, res) {
        var name = req.body.wallet_id
        auth.register(name, req.body.pin, function(err, token){
            if(err) {
                console.error('error', err)
                return res.status(400).send(err)
            }

            setCookie(req, name, function(){
                console.log('registered wallet %s', name)
                res.status(200).send(token)
            })
        })
    })

    app.post('/login', validateAuthParams(true), function(req, res) {
        var name = req.body.wallet_id
        auth.login(name, req.body.pin, function(err, token){
            if(err) {
                console.error('error', err)
                return res.status(400).send(err)
            }

            setCookie(req, name, function(){
                console.log('authenticated wallet %s', name)
                res.status(200).send(token)
            })
        })
    })

    app.get('/exist', function(req, res){
        var name = req.query.wallet_id
        if (!name) return res.status(400).json({error: 'Bad request'});

        auth.exist(name, function(err, userExist){
            if(err) {
                console.error('error', err)
                return res.status(400).send(err)
            }

            res.status(200).send(userExist)
        })
    })

    app.delete('/pin', restrict, function(req, res) {
        var id = req.body.id
        var pin = req.body.pin

        auth.disablePin(id, pin, function(err){
            if(err) return res.status(400).send(err)
            res.status(200).send()
        })
    })

    app.get('/reset', function(req, res){
        var name = req.query.wallet_id
        if (!name) return res.status(400).json({error: 'Bad request'});

        auth.resetPin(name, function(err){
            res.status(200).send(err)
        })
    })

    app.post('/location', function(req, res) {
        var args = prepareGeoData(req, res)

        args.push(function(err) {
            if(err) return res.status(400).json(err);
            res.status(201).send()
        })

        geo.save.apply(null, args)
    })

    app.put('/location', function(req, res) {
        var args = prepareGeoData(req, res)
        args.push(function(err, results) {
            if(err) return res.status(400).json(err)
            res.status(200).json(results)
        })

        geo.search.apply(null, args)
    })

    function prepareGeoData(req){
        var data = req.body

        var lat = data.lat
        var lon = data.lon
        delete data.lat
        delete data.lon

        var id = req.session.tmpSessionID
        if(!id) {
            id = crypto.randomBytes(16).toString('base64')
            req.session.tmpSessionID = id
        }
        data.id = id

        return [lat, lon, data]
    }

    app.delete('/location', function(req, res) {
        geo.remove(req.session.tmpSessionID)
        res.status(200).send()
    })

    app.use(function(err, req, res){
        console.error(err.stack);
        res.status(500).send('Oops! something went wrong.');
    })


    function validateAuthParams(allowMissingPin) {
        return function (req, res, next) {
            if (!req.body.wallet_id || !validatePin(req.body.pin, allowMissingPin)) {
                return res.status(400).json({error: 'Bad request'})
            }

            next()
        }
    }

    function restrict(req, res, next) {
        var session_id = req.session.wallet_id
        if (session_id && session_id === req.body.id) {
            next()
        } else {
            return res.status(401).send()
        }
    }

    function setCookie(req, wallet_id, callback){
        req.session.wallet_id = wallet_id
        callback()
    }

    function requireHTTPS(req, res, next) {
        var herokuForwardedFromHTTPS = req.headers['x-forwarded-proto'] === 'https'
        if (!herokuForwardedFromHTTPS && isProduction()) {
            return res.redirect('https://' + req.get('host') + req.url)
        }
        next()
    }

    function isProduction(){
        return process.env.NODE_ENV === 'production'
    }
    return app
}
