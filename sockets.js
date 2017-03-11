var socketIO = require('socket.io'),
    uuid = require('node-uuid'),
    crypto = require('crypto');

// Kurento specifics
var kurento = require('kurento-client');
var idCounter = 0;
var candidatesQueue = {};
var kurentoClient = null;
//var presenter = null;
var viewers = [];
var noPresenterMessage = 'No active presenter. Try again later...';
var ws_uri;
var presenterList = {};
var viewersList = {};

module.exports = function (server, config) {
    var io = socketIO.listen(server);

    ws_uri = config.kurento.ws_uri;

    io.sockets.on('connection', function (client) {
        console.log("new connection")
        //console.log(stringifyCyclic(client));

        var sessionId = nextUniqueId();
        console.log("Session ID: " + sessionId);

        client.resources = {
            screen: false,
            video: true,
            audio: false
        };

        // pass a message to another id
        client.on('message', function (details) {
            console.log("new message");
            console.log(JSON.stringify(details));

            if (!details) return;
            
            // Kurento specific message handling
            var message = JSON.parse(details);
            console.log('Connection ' + sessionId + ' received message ', message);

            switch (message.id) {
                case 'presenter':
                    startPresenter(sessionId, client, message.sdpOffer, function (error, sdpAnswer) {
                        if (error) {
                            return client.emit('message', JSON.stringify({
                                id: 'presenterResponse',
                                response: 'rejected',
                                message: error
                            }));
                        }
                        client.emit('message', JSON.stringify({
                            id: 'presenterResponse',
                            response: 'accepted',
                            sdpAnswer: sdpAnswer
                        }));
                    });
                    break;

                case 'viewer':
                    startViewer(sessionId, client, message.sdpOffer, function (error, sdpAnswer) {
                        if (error) {
                            return client.emit('message', JSON.stringify({
                                id: 'viewerResponse',
                                response: 'rejected',
                                message: error
                            }));
                        }

                        client.emit('message', JSON.stringify({
                            id: 'viewerResponse',
                            response: 'accepted',
                            sdpAnswer: sdpAnswer
                        }));
                    });
                    break;

                case 'stop':
                    stop(sessionId, client);
                    break;

                case 'onIceCandidate':
                    onIceCandidate(sessionId, client, message.candidate);
                    break;

                default:
                    client.emit('message', JSON.stringify({
                        id: 'error',
                        message: 'Invalid message ' + message
                    }));
                    break;
            }

            var otherClient = io.to(details.to);
            if (!otherClient) return;

            details.from = client.id;
            otherClient.emit('message', details);
        });

        client.on('shareScreen', function () {
            console.log("shareScreen");
            client.resources.screen = true;
        });

        client.on('unshareScreen', function (type) {
            console.log("unshareScreen");
            client.resources.screen = false;
            removeFeed('screen');
        });

        client.on('join', join);

        function removeFeed(type) {
            console.log("removeFeed");
            if (client.room) {
                io.sockets.in(client.room).emit('remove', {
                    id: client.id,
                    type: type
                });
                if (!type) {
                    client.leave(client.room);
                    client.room = undefined;
                }
            }
        }

        function join(name, cb) {
            console.log("join " + name);
            
            // sanity check
            if (typeof name !== 'string') return;
            // check if maximum number of clients reached
            if (config.rooms && config.rooms.maxClients > 0 &&
                clientsInRoom(name) >= config.rooms.maxClients) {
                safeCb(cb)('full');
                return;
            }
            // leave any existing rooms
            removeFeed();
            stop(sessionId, client);
            safeCb(cb)(null, describeRoom(name));
            client.join(name);
            client.room = name;
        }

        // we don't want to pass "leave" directly because the
        // event type string of "socket end" gets passed too.
        client.on('disconnect', function () {
            console.log("disconnect");
            removeFeed();
            stop(sessionId, client);
        });
        client.on('leave', function () {
            console.log("leave");
            removeFeed();
            stop(sessionId, client);
        });

        client.on('create', function (name, cb) {
            console.log("create " + name);
            if (arguments.length == 2) {
                cb = (typeof cb == 'function') ? cb : function () {};
                name = name || uuid();
            } else {
                cb = name;
                name = uuid();
            }
            // check if exists
            var room = io.nsps['/'].adapter.rooms[name];
            if (room && room.length) {
                safeCb(cb)('taken');
            } else {
                join(name);
                safeCb(cb)(null, name);
            }
        });

        // support for logging full webrtc traces to stdout
        // useful for large-scale error monitoring
        client.on('trace', function (data) {
            console.log('trace', JSON.stringify(
            [data.type, data.session, data.prefix, data.peer, data.time, data.value]
            ));
        });

        // Kurento handles this for us.
        // tell client about stun and turn servers and generate nonces
        /* client.emit('stunservers', config.stunservers || []);

        // create shared secret nonces for TURN authentication
        // the process is described in draft-uberti-behave-turn-rest
        var credentials = [];
        // allow selectively vending turn credentials based on origin.
        var origin = client.handshake.headers.origin;
        if (!config.turnorigins || config.turnorigins.indexOf(origin) !== -1) {
            config.turnservers.forEach(function (server) {
                var hmac = crypto.createHmac('sha1', server.secret);
                // default to 86400 seconds timeout unless specified
                var username = Math.floor(new Date().getTime() / 1000) + (server.expiry || 86400) + "";
                hmac.update(username);
                credentials.push({
                    username: username,
                    credential: hmac.digest('base64'),
                    urls: server.urls || server.url
                });
            });
        }
        client.emit('turnservers', credentials); */

        // Kurento / butterflymx specific message handling
    });


    function describeRoom(name) {
        var adapter = io.nsps['/'].adapter;
        var clients = adapter.rooms[name] || {};
        var result = {
            clients: {}
        };
        Object.keys(clients).forEach(function (id) {
            result.clients[id] = adapter.nsp.connected[id].resources;
        });
        return result;
    }

    function clientsInRoom(name) {
        return io.sockets.clients(name).length;
    }

};

function safeCb(cb) {
    if (typeof cb === 'function') {
        return cb;
    } else {
        return function () {};
    }
}

function stringifyCyclic(obj) {
    seen = [];

    return JSON.stringify(obj, function (key, val) {
        if (val != null && typeof val == "object") {
            if (seen.indexOf(val) >= 0) {
                return;
            }
            seen.push(val);
        }
        return val;
    });
}

// Kurento integration
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(ws_uri, function (error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + ws_uri);
            return callback("Could not find media server at address" + ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function startPresenter(sessionId, client, sdpOffer, callback) {
    clearCandidatesQueue(sessionId);

    // if (presenter !== null) {
    if (typeof presenterList[client.room] != "undefined" &&
        presenterList[client.room] !== null) {
        console.log("Presenter already: " + JSON.stringify(presenterList[client.room]));
        stop(sessionId, client);
        return callback("Another user is currently acting as presenter. Try again later ...");
    }

    // presenter = {
    presenterList[client.room] = {
        id: sessionId,
        pipeline: null,
        webRtcEndpoint: null
    }

    getKurentoClient(function (error, kurentoClient) {
        if (error) {
            stop(sessionId, client);
            return callback(error);
        }

        // if (presenter === null) {
        if (presenterList[client.room] === null) {
            stop(sessionId, client);
            return callback(noPresenterMessage);
        }

        kurentoClient.create('MediaPipeline', function (error, pipeline) {
            if (error) {
                stop(sessionId, client);
                return callback(error);
            }

            // if (presenter === null)              
            if (presenterList[client.room] == null) {
                stop(sessionId, client);
                return callback(noPresenterMessage);
            }
            //presenter.pipeline = pipeline;
            presenterList[client.room].pipeline = pipeline;
            pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
                if (error) {
                    stop(sessionId, client);
                    return callback(error);
                }

                //if (presenter === null) {
                if (presenterList[client.room] === null) {
                    stop(sessionId, client);
                    return callback(noPresenterMessage);
                }

                //presenter.webRtcEndpoint = webRtcEndpoint;
                presenterList[client.room].webRtcEndpoint = webRtcEndpoint;

                if (candidatesQueue[sessionId]) {
                    while (candidatesQueue[sessionId].length) {
                        var candidate = candidatesQueue[sessionId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                webRtcEndpoint.on('OnIceCandidate', function (event) {
                    var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                    client.emit('message', JSON.stringify({
                        id: 'iceCandidate',
                        candidate: candidate
                    }));
                });

                webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
                    if (error) {
                        stop(sessionId, client);
                        return callback(error);
                    }

                    //if (presenter === null) {
                    if (presenterList[client.room] === null) {
                        stop(sessionId, client);
                        return callback(noPresenterMessage);
                    }

                    callback(null, sdpAnswer);
                });

                webRtcEndpoint.gatherCandidates(function (error) {
                    if (error) {
                        stop(sessionId, client);
                        return callback(error);
                    }
                });
            });
        });
    });
}


function startViewer(sessionId, client, sdpOffer, callback) {
    clearCandidatesQueue(sessionId);

    // if (presenter === null) {
    if (typeof presenterList[client.room] == "undefined" ||
        presenterList[client.room] == null) {
        stop(sessionId, client);
        return callback(noPresenterMessage);
    }
    //var presenter = presenterList[client.room];

    //presenter.pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
    presenterList[client.room].pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
        if (error) {
            stop(sessionId, client);
            return callback(error);
        }
        //viewers[sessionId] = {
        if (typeof viewersList[client.room] == "undefined" || viewersList[client.room] == null) {
            viewersList[client.room] = [];
        }
        viewersList[client.room][sessionId] = {
            "webRtcEndpoint": webRtcEndpoint,
            "client": client
        }

        // if (presenter === null) {
        if (presenterList[client.room] == null) {
            stop(sessionId, client);
            return callback(noPresenterMessage);
        }

        if (candidatesQueue[sessionId]) {
            while (candidatesQueue[sessionId].length) {
                var candidate = candidatesQueue[sessionId].shift();
                webRtcEndpoint.addIceCandidate(candidate);
            }
        }

        webRtcEndpoint.on('OnIceCandidate', function (event) {
            var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
            client.emit('message', JSON.stringify({
                id: 'iceCandidate',
                candidate: candidate
            }));
        });

        webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
            if (error) {
                stop(sessionId, client);
                return callback(error);
            }
            // if (presenter === null) {
            if (presenterList[client.room] === null) {
                stop(sessionId, client);
                return callback(noPresenterMessage);
            }

            //presenter.webRtcEndpoint.connect(webRtcEndpoint, function (error) {
            presenterList[client.room].webRtcEndpoint.connect(webRtcEndpoint, function (error) {
                if (error) {
                    stop(sessionId, client);
                    return callback(error);
                }
                // if (presenter === null) {
                if (presenterList[client.room] === null) {
                    stop(sessionId, client);
                    return callback(noPresenterMessage);
                }

                callback(null, sdpAnswer);
                webRtcEndpoint.gatherCandidates(function (error) {
                    if (error) {
                        stop(sessionId, client);
                        return callback(error);
                    }
                });
            });
        });
    });
}

function clearCandidatesQueue(sessionId) {
    if (candidatesQueue[sessionId]) {
        delete candidatesQueue[sessionId];
    }
}

function stop(sessionId, client) {
    // if (presenter !== null && presenter.id == sessionId) {
    if (presenterList[client.room] !== null && typeof presenterList[client.room] != "undefined" &&
        presenterList[client.room].id == sessionId) {
        //for (var i in viewers) {
        //    var viewer = viewers[i];
        for (var i in viewersList[client.room]) {
            var viewer = viewersList[client.room][i];
            if (viewer.client) {
                viewer.client.emit('message', JSON.stringify({
                    id: 'stopCommunication'
                }));
            }
        }
        //presenter.pipeline.release();
        //presenter = null;
        presenterList[client.room].pipeline.release();
        presenterList[client.room] = null;
        // viewers = [];
        viewersList[client.room] = [];
    } else if (typeof viewersList[client.room] != "undefined" && viewersList[client.room][sessionId]) {
        viewersList[client.room][sessionId].webRtcEndpoint.release();
        delete viewersList[client.room][sessionId];
    } 
    /* } else if (viewers[sessionId]) {
        viewers[sessionId].webRtcEndpoint.release();
        delete viewers[sessionId];
    } */

    clearCandidatesQueue(sessionId);
}

function onIceCandidate(sessionId, client, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);

    //if (presenter && presenter.id === sessionId && presenter.webRtcEndpoint) {
    if (presenterList[client.room] && presenterList[client.room].id === sessionId &&
        presenterList[client.room].webRtcEndpoint) {
        console.info('Sending presenter candidate');
        //presenter.webRtcEndpoint.addIceCandidate(candidate);
        presenterList[client.room].webRtcEndpoint.addIceCandidate(candidate);
    }
    else if (typeof viewersList[client.room] != "undefined" && viewersList[client.room][sessionId]
             && viewersList[client.room][sessionId].webRtcEndpoint) {
        console.info('Sending viewer candidate');
        viewersList[client.room][sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    /* else if (viewers[sessionId] && viewers[sessionId].webRtcEndpoint) {
        console.info('Sending viewer candidate');
        viewers[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    } */
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

function nextUniqueId() {
    idCounter++;
    return idCounter.toString();
}