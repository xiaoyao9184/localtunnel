var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('localtunnel:client');
var net = require('net');
var yallist = require('yallist');

var HeaderHostTransformer = require('./HeaderHostTransformer');

// manages groups of tunnels
var TunnelCluster = function(opt) {
    if (!(this instanceof TunnelCluster)) {
        return new TunnelCluster(opt);
    }

    var self = this;
    self._opt = opt;

    EventEmitter.call(self);
};

TunnelCluster.prototype.__proto__ = EventEmitter.prototype;

// establish a new tunnel
TunnelCluster.prototype.open = function() {
    var self = this;

    var opt = self._opt || {};

    var remote_host = opt.remote_host;
    var remote_port = opt.remote_port;

    var local_host = opt.local_host || 'localhost';
    var local_port = opt.local_port;


    var port_info = {
        remote_local: 0,
        local_local: 0
    }

    //
    var chain = {
        //remote to local
        up: yallist.create(),
        //local to remote
        down: yallist.create()
    };

    debug('establishing tunnel %s:%s <> %s:%s', local_host, local_port, remote_host, remote_port);

    // connection to localtunnel server
    var remote = net.connect({
        host: remote_host,
        port: remote_port
    });

    remote.setKeepAlive(true);

    remote.on('error', function(err) {
        // emit connection refused errors immediately, because they
        // indicate that the tunnel can't be established.
        if (err.code === 'ECONNREFUSED') {
            self.emit('error', new Error('connection refused: ' + remote_host + ':' + remote_port + ' (check your firewall settings)'));
        }

        remote.end();
    });

    function conn_local(initRemote = true) {
        if (remote.destroyed) {
            debug('remote destroyed');
            self.emit('dead');
            return;
        }

        debug('connecting locally to %s:%d', local_host, local_port);
        remote.pause();

        // connection to local http server
        var local = net.connect({
            host: local_host,
            port: local_port
        });
        local.setKeepAlive(true);

        //remote disable
        function remote_close() {
            debug('remote close');
            if (!local.destroyed) {
                // remote.removeListener('close', remote_close);
                local.destroy();
                self.emit('dead');
            }
        };

        function remote_dis() {
            if(opt.sync_status){
                //end local now
                local.end();
            }else{
                local.pause();
                local.unpipe(remote);
                remote.unpipe(local);
                //new remote
            }
        };


        if(initRemote){
            remote.once('end', function(had_error){
                debug('remote connection end [%s]', had_error);
                remote_dis();
            });
            
            remote.once('close', remote_close);
        }


        //local disable
        function local_close() {
            debug('local close');
            if(opt.sync_status){
                if (!remote.destroyed) {
                    // remote.removeListener('close', remote_close);
                    remote.destroy();
                    self.emit('dead');
                }
            }
        };

        function local_dis() {
            if(opt.sync_status){
                //end remote now
                remote.end();
            }else{
                remote.pause();
                // remote.removeListener('close', remote_close);

                //remove local
                var local_old = chain.up.pop();
                var local_old2 = chain.down.shift();

                //unpipe
                chain.up.tail.value.unpipe(local);
                local.unpipe(chain.down.head.value);

                // retrying connection to local server
                local_connect_retrying();
            }
        };


        // TODO some languages have single threaded servers which makes opening up
        // multiple local connections impossible. We need a smarter way to scale
        // and adjust for such instances to avoid beating on the door of the server
        local.once('error', function(err) {
            debug('local error %s', err.message);
            local.end();

            // remote.removeListener('close', remote_close);

            if (err.code !== 'ECONNREFUSED') {
                return remote.end();
            }

            // retrying connection to local server
            local_connect_retrying();
        });

        local.once('connect', function() {
            debug('connected locally');
            
            port_info.local_local = this.localPort;
            debug('connect to local[%s] with tunnel[%s->%s]', 
                    this.remotePort,
                    port_info.remote_local,
                    port_info.local_local);
            
            if(chain.up.length == 0){
                chain.up.push(remote);
                
                // if user requested specific local host
                // then we use host header transform to replace the host header
                if (opt.local_host) {
                    debug('transform Host header to %s', opt.local_host);
                    var hht = HeaderHostTransformer({ host: opt.local_host });
                    chain.up.push(hht);
    
                    remote.pipe(hht, {
                        end: false
                    });
                }
            }
    
            //up chain
            //add to the tail
            chain.up.tail.value.pipe(local, {
                end: false
            });
            chain.up.push(local);

            if(chain.down.length == 0){
                chain.down.unshift(remote);
            }

            //down chain
            //add to the head
            local.pipe(chain.down.head.value, {
                end: false
            });
            chain.down.unshift(local);

            debug('transform port form remote[%s] through tunnel[%s->%s] to local[%s]', 
                remote.remotePort,
                remote.localPort,
                local.localPort,
                local.remotePort);


            //
            local.once('end',function(had_error){
                debug('local[%s] connection end with tunnel[%s->%s] [%s]', 
                    this.remotePort,
                    port_info.remote_local,
                    port_info.local_local,
                    had_error);
                local_dis();
            });

            // when local closes, also get a new remote
            local.once('close', function(had_error) {
                debug('local connection closed [%s]', had_error);
                local_close();
            });


            //done
            remote.resume();
        });

        function local_connect_retrying() {
            setTimeout(function(){
                conn_local(false);
            },1000)
        }
    }

    remote.on('data', function(data) {
        debug('accept data form remote[%s] to tunnel[%s->%s]', 
                this.remotePort,
                port_info.remote_local,
                port_info.local_local);
                // this.localPort);
        const match = data.toString().match(/^(\w+) (\S+)/);
        if (match) {
            self.emit('request', {
                method: match[1],
                path: match[2],
            });
        }
    });

    // tunnel is considered open when remote connects
    remote.once('connect', function() {
        port_info.remote_local = this.localPort;
        debug('connect to remote[%s] with tunnel[%s->%s]', 
                this.remotePort,
                port_info.remote_local,
                port_info.local_local);
        self.emit('open', remote);
        conn_local();
    });
};

module.exports = TunnelCluster;
