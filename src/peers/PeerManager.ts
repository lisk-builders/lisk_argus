import { OwnNodeOptions, Peer, PeerInfo, PeerState } from "libargus";
import * as semver from "semver";
import * as _ from "underscore";
import * as log from "winston";

import { SocketServer } from "../websockets/SocketServer";

const config = require("../../src/config.json");

/***
 * PeerManager keeps track of connected peers.
 * It automatically discovers new peers and connects to them.
 */
export class PeerManager {
  private bestHeight: number = 0;
  private bestBroadhash: string = "";

  constructor(private socketServer: SocketServer, private readonly ownNode: OwnNodeOptions) {
    this.addPeer({
      ip: config.seedNode.host,
      wsPort: config.seedNode.wsPort,
      httpPort: config.seedNode.httpPort,
      version: config.seedNode.version,
      nonce: "",
    });
    setInterval(() => this.updatePeers(), 1000);

    socketServer.on("status", data => {
      this.handleStatusUpdate(data);
    });

    socketServer.on("connect", data => this.wsServerConnectionChanged(data, true));
    socketServer.on("disconnect", data => this.wsServerConnectionChanged(data, false));
  }

  private readonly _peers = new Map<string, Peer>();

  get peers(): Peer[] {
    return Array.from(this._peers.values());
  }

  /***
   * Adds a peer and connects to it
   * @param {PeerInfo} peer
   */
  public addPeer(peer: PeerInfo) {
    if (peer.nonce === this.ownNode.nonce || peer.nonce.indexOf("monitoring") !== -1) {
      return;
    }
    if (this._peers.has(peer.nonce)) return log.debug("peer not added: already connected to peer");
    if (!semver.satisfies(peer.version, config.minVersion))
      return log.debug("peer not added: does not satisfy minVersion", {
        version: peer.version,
        ip: peer.ip,
        port: peer.wsPort,
      });

    this._peers.set(
      peer.nonce,
      new Peer(
        {
          ip: peer.ip,
          wsPort: peer.wsPort,
          httpPort: peer.httpPort,
          nethash: config.nethash,
          nonce: peer.nonce,
        },
        this.ownNode,
      ),
    );
  }

  /***
   * Update the status of all peers, handle new peers and update data
   */
  updatePeers() {
    // Flatten all peer stats
    let peerList = _.without(
      _.flatten(
        _.map(Array.from(this._peers.values()), peer => {
          return peer.peers;
        }),
      ),
      undefined,
    );

    for (const peer of this._peers.values()) {
      if (peer.status && peer.status.height > this.bestHeight) {
        this.bestHeight = peer.status.height;
        this.bestBroadhash = peer.status.broadhash;
      }
    }

    // Discover new peers
    let newPeers: PeerInfo[] = [];
    for (let peer of peerList) {
      if (
        _.find(Array.from(this._peers.values()), item => {
          return item.options.nonce === peer.nonce;
        })
      )
        continue;

      if (
        _.find(newPeers, item => {
          return item.nonce === peer.nonce || peer.nonce === this.ownNode.nonce;
        })
      )
        continue;

      newPeers.push(peer);
    }

    // Connect to new peers
    for (let peer of newPeers) {
      this.addPeer(peer);
    }

    log.debug(
      `connected to ${
        _.countBy(
          Array.from(this._peers.values()).map(peer => peer.state),
          state => PeerState[state],
        )[PeerState.Online]
      } peers`,
    );
    log.debug(
      `State of the network: ${JSON.stringify(
        _.countBy(
          Array.from(this._peers.values()).map(
            peer =>
              peer.status != null && peer.state == PeerState.Online ? peer.status.height : 0,
          ),
          height => height,
        ),
      )} peers`,
    );
    log.debug(
      `disconnected from ${
        _.countBy(
          Array.from(this._peers.values()).map(peer => peer.state),
          state => PeerState[state],
        )[PeerState.Offline]
      } peers`,
    );
  }

  /***
   * Get a peer with the best height and activated HTTP API
   * @returns {Peer}
   */
  public getBestHTTPPeer(): Peer {
    let bestPeer: Peer | undefined;
    let bestHeight = 0;

    // Shuffle peers to guarantee that we use different ones every time
    let shuffledPeers = Array.from(this._peers.values());
    shuffledPeers = _.shuffle(shuffledPeers);

    for (let peer of shuffledPeers) {
      if (!peer.httpActive) continue;

      if ((peer.status ? peer.status.height : 0) >= bestHeight) {
        bestPeer = peer;
        bestHeight = peer.status ? peer.status.height : 0;
      }
    }

    if (!bestPeer) {
      // TODO: undefined should be a valid result type for getBestHTTPPeer
      throw new Error("No best peer found");
    }

    return bestPeer;
  }

  /***
   * Get the best blockchain height of all peers
   * @returns {number}
   */
  public getBestHeight(): number {
    return this.bestHeight;
  }

  /***
   * Updates the peer from a status update
   * This is invoked when an updateMyself message is sent by a Lisk node
   * @param update
   */
  public handleStatusUpdate(update: any) {
    if (!update.nonce) return;

    const peer = this._peers.get(update.nonce);
    if (!peer) return;
    peer.handleStatusUpdate(update);
  }

  /***
   * Handles connection changes of the incoming WebSocket
   * @param {String} nonce
   * @param {Boolean} connected
   */
  private wsServerConnectionChanged(nonce: string, connected: boolean) {
    if (!this._peers.has(nonce)) return;

    const peer = this._peers.get(nonce);
    if (!peer) return;
    peer.setWebsocketServerConnected(connected);
  }
}
