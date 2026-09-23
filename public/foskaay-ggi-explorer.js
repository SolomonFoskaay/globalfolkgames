// public/foskaay-ggi-explorer.js
// Reads-only Foskaay GGI explorer helpers. NO writes, NO keys, NO backend: every
// value on the explorer comes from the Arc contracts + RPC directly, which is the
// point (a dev or a grant reviewer can verify the claim without trusting us).
//
// The clean 2-contract core has NO on-chain session storage. A session is proven
// by its EVENTS: Handover (connect) and Settled (result), both on SessionRegistry,
// plus the fee state on FeeVault. This file reads those events with eth_getLogs.
(function () {
    'use strict';

    var NET = {
        name: 'Arc Testnet',
        chainId: 5042002,
        rpc: 'https://rpc.testnet.arc.io',
        explorer: 'https://explorer.testnet.arc.io',
        usdc: '0x3600000000000000000000000000000000000000',
        contracts: {
            SessionRegistry: '0xb0A5A2D316bEEd2f75786cb60bfa2256C52281eE',
            FeeVault: '0x9EE0b4c1622C5f2B7710b1fe4Ec2Be86833aDe39'
        }
    };

    // Event topic0 hashes (keccak of the event signature). Recomputed with
    // `cast keccak "<signature>"`. If an event signature ever changes, recompute.
    var TOPIC = {
        Handover: '0xc69c4b768b98598156326b0b2d4e43b9003425598e82882635dbf28e4fcf3cf6',
        Settled: '0x12e9909fa20d454f1d832410840022a48385ad716d10570278d043c3a15b6595'
    };

    // Precomputed view selectors, pinned so the page needs no crypto library.
    var SELECTORS = {
        'paid(bytes32)': '0xadd89bb2',
        'fee()': '0xddca3f43',
        'collected()': '0x84bcefd4',
        'destination()': '0xb269681d',
        'midchainDigest(bytes32,bytes32)': '0x00918792'
    };

    function rpc(method, params) {
        return fetch(NET.rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params || [] })
        }).then(function (r) { return r.json(); }).then(function (j) {
            if (j.error) throw new Error(j.error.message || 'rpc error');
            return j.result;
        });
    }

    function ethCall(to, data) {
        return rpc('eth_call', [{ to: to, data: data }, 'latest']);
    }

    function callView(to, sig, argsData) {
        return ethCall(to, SELECTORS[sig] + (argsData || ''));
    }

    function getLogs(address, topic0, sessionId) {
        return rpc('eth_getLogs', [{
            address: address,
            topics: [topic0, sessionId],
            fromBlock: '0x0',
            toBlock: 'latest'
        }]);
    }

    // ---- tiny ABI decoding (no dependency) ------------------------------------
    function w(data, i) { return data.slice(2 + i * 64, 2 + (i + 1) * 64); }
    function addrFromWord(hexWord) { return '0x' + hexWord.slice(24); }
    function addrFromTopic(topic) { return '0x' + topic.slice(26); }
    function bytes32FromWord(hexWord) { return '0x' + hexWord; }
    function numFromWord(hexWord) { return BigInt('0x' + hexWord); }
    function boolFromHex(hex) { return hex && hex !== '0x' && BigInt(hex) !== 0n; }

    // Non-indexed Handover data: startHash, seedCommit, players[], sessionKeys[], randomCount
    function decodeHandover(data) {
        if (!data || data.length < 2 + 5 * 64) return null;
        return {
            startHash: bytes32FromWord(w(data, 0)),
            seedCommit: bytes32FromWord(w(data, 1)),
            players: readAddrArray(data, Number(numFromWord(w(data, 2)))),
            sessionKeys: readAddrArray(data, Number(numFromWord(w(data, 3)))),
            randomCount: Number(numFromWord(w(data, 4)))
        };
    }

    // Non-indexed Settled data: finalHash, seedReveal
    function decodeSettled(data) {
        if (!data || data.length < 2 + 2 * 64) return null;
        return {
            finalHash: bytes32FromWord(w(data, 0)),
            seedReveal: bytes32FromWord(w(data, 1))
        };
    }

    // Dynamic address[] at a byte offset from the start of `data`.
    function readAddrArray(data, byteOffset) {
        var out = [];
        try {
            var len = Number(numFromWord(data.slice(2 + byteOffset * 2, 2 + byteOffset * 2 + 64)));
            for (var i = 0; i < len; i++) {
                var start = 2 + (byteOffset + 32 + i * 32) * 2 + 24;
                out.push('0x' + data.slice(start, start + 40));
            }
        } catch (e) { /* soft */ }
        return out;
    }

    // ---- Public API -----------------------------------------------------------
    function loadSession(sessionId) {
        var C = NET.contracts;
        var idArg = sessionId.replace(/^0x/, '');
        return Promise.all([
            getLogs(C.SessionRegistry, TOPIC.Handover, sessionId).catch(function () { return []; }),
            getLogs(C.SessionRegistry, TOPIC.Settled, sessionId).catch(function () { return []; }),
            callView(C.FeeVault, 'paid(bytes32)', idArg).catch(function () { return '0x'; }),
            callView(C.FeeVault, 'fee()').catch(function () { return '0x'; }),
            callView(C.FeeVault, 'collected()').catch(function () { return '0x'; }),
            callView(C.FeeVault, 'destination()').catch(function () { return '0x'; })
        ]).then(function (r) {
            var hLog = r[0][0], sLog = r[1][0];
            var handover = null, settled = null;
            if (hLog) {
                var d = decodeHandover(hLog.data) || {};
                handover = {
                    gameLogic: hLog.topics[2] ? addrFromTopic(hLog.topics[2]) : null,
                    payer: hLog.topics[3] ? addrFromTopic(hLog.topics[3]) : null,
                    startHash: d.startHash, seedCommit: d.seedCommit,
                    players: d.players || [], sessionKeys: d.sessionKeys || [],
                    randomCount: d.randomCount || 0,
                    block: Number(BigInt(hLog.blockNumber)),
                    tx: hLog.transactionHash
                };
            }
            if (sLog) {
                var sd = decodeSettled(sLog.data) || {};
                settled = {
                    finalHash: sd.finalHash, seedReveal: sd.seedReveal,
                    payer: sLog.topics[2] ? addrFromTopic(sLog.topics[2]) : null,
                    block: Number(BigInt(sLog.blockNumber)),
                    tx: sLog.transactionHash
                };
            }
            return {
                sessionId: sessionId,
                connected: Boolean(handover),
                handover: handover,
                settled: settled,
                paid: boolFromHex(r[2]),
                fee: numFromWord(r[3] || '0x0'),
                collected: numFromWord(r[4] || '0x0'),
                destination: r[5] && r[5] !== '0x' ? addrFromWord(r[5].slice(2)) : null
            };
        });
    }

    // The exact digest the players sign. Pure read; costs nothing.
    function midchainDigest(sessionId, finalHash) {
        var args = sessionId.replace(/^0x/, '') + finalHash.replace(/^0x/, '');
        return callView(NET.contracts.SessionRegistry, 'midchainDigest(bytes32,bytes32)', args);
    }

    window.GGExplorer = {
        NET: NET,
        TOPIC: TOPIC,
        rpc: rpc,
        callView: callView,
        loadSession: loadSession,
        midchainDigest: midchainDigest,
        decodeHandover: decodeHandover,
        decodeSettled: decodeSettled
    };
})();
