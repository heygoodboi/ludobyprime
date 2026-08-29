// js/firebase-room.js
// Firebase Room / Lobby module
// Requires Firebase Compat SDK + window.FirebaseAuth

(function () {
  'use strict';

  // --------------------------------------------------
  // Firebase SDK check
  // --------------------------------------------------

  if (!window.firebase || !firebase.database) {
    console.error(
      'Firebase SDK not loaded. js/firebase-room.js requires Firebase.'
    );

    window.FirebaseRoom = {
      createRoom: async () => ({
        success: false,
        error: 'AUTH_REQUIRED'
      }),

      joinRoom: async () => ({
        success: false,
        error: 'AUTH_REQUIRED'
      }),

      leaveRoom: async () => ({
        success: false,
        error: 'AUTH_REQUIRED'
      }),

      getRoom: async () => null,

      getPlayers: async () => [],

      getRoomCode: () => null,

      getCurrentPlayer: () => null,

      isHost: async () => false,

      onRoomChanged: () => () => {},

      onPlayersChanged: () => () => {}
    };

    return;
  }

  // --------------------------------------------------
  // Firebase references
  // --------------------------------------------------

  const db = firebase.database();
  const ServerValue = firebase.database.ServerValue;

  const COLORS = [
    'red',
    'green',
    'yellow',
    'blue'
  ];

  // --------------------------------------------------
  // Helpers
  // --------------------------------------------------

  function normalizeCode(code) {
    return String(code || '')
      .trim()
      .toUpperCase();
  }

  function generateRoomCode() {
    return Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();
  }

  function validRoomCode(code) {
    return /^[A-Z0-9_-]{3,20}$/.test(code);
  }

  function validName(name) {
    if (typeof name !== 'string') {
      return false;
    }

    const value = name.trim();

    return value.length >= 1 && value.length <= 50;
  }

  function cleanName(name) {
    return String(name || '')
      .trim()
      .replace(/[<>]/g, '')
      .substring(0, 50);
  }

  // --------------------------------------------------
  // Authentication
  // --------------------------------------------------

  async function ensureAuth() {
    if (
      !window.FirebaseAuth ||
      !window.FirebaseAuth.firebaseAuthReady
    ) {
      throw new Error('AUTH_REQUIRED');
    }

    const user = await window.FirebaseAuth.firebaseAuthReady;

    if (!user || !user.uid) {
      throw new Error('AUTH_REQUIRED');
    }

    return user;
  }

  // --------------------------------------------------
  // Color assignment
  // --------------------------------------------------

  function pickColorFromPlayers(players) {
    const used = new Set();

    if (players && typeof players === 'object') {
      Object.values(players).forEach(function (player) {
        if (player && player.color) {
          used.add(player.color);
        }
      });
    }

    for (const color of COLORS) {
      if (!used.has(color)) {
        return color;
      }
    }

    return null;
  }

  // --------------------------------------------------
  // CREATE ROOM
  // --------------------------------------------------

  async function createRoom(roomCodeRaw, playerName) {
    try {
      console.log('[FirebaseRoom] Creating room...');

      const user = await ensureAuth();

      const uid = user.uid;

      let roomCode = normalizeCode(roomCodeRaw);

      if (!roomCode) {
        roomCode = generateRoomCode();
      }

      const name = cleanName(playerName);

      // Validation
      if (!validRoomCode(roomCode)) {
        return {
          success: false,
          error: 'INVALID_ROOM_CODE'
        };
      }

      if (!validName(name)) {
        return {
          success: false,
          error: 'INVALID_NAME'
        };
      }

      const roomRef = db.ref('rooms/' + roomCode);

      // ------------------------------------------------
      // IMPORTANT:
      // Firebase Compat transaction signature is:
      //
      // transaction(updateFunction, onComplete, applyLocally)
      //
      // NOT:
      //
      // transaction(updateFunction, { applyLocally:false })
      //
      // ------------------------------------------------

      const result = await new Promise(function (resolve, reject) {
        roomRef.transaction(
          function (currentData) {
            // Room already exists.
            // Abort transaction.
            if (currentData !== null) {
              return;
            }

            // First player automatically becomes host.
            return {
              hostId: uid,

              status: 'waiting',

              createdAt: ServerValue.TIMESTAMP,

              maxPlayers: 4,

              players: {
                [uid]: {
                  uid: uid,
                  name: name,
                  color: COLORS[0],
                  online: true,
                  joinedAt: ServerValue.TIMESTAMP
                }
              }
            };
          },

          // onComplete callback
          function (error, committed, snapshot) {
            if (error) {
              reject(error);
              return;
            }

            resolve({
              committed: committed,
              snapshot: snapshot
            });
          },

          // applyLocally
          false
        );
      });

      if (!result.committed) {
        console.warn(
          '[FirebaseRoom] Room already exists:',
          roomCode
        );

        return {
          success: false,
          error: 'ROOM_EXISTS'
        };
      }

      // ------------------------------------------------
      // Presence / disconnect handling
      // ------------------------------------------------

      const onlineRef = db.ref(
        'rooms/' +
        roomCode +
        '/players/' +
        uid +
        '/online'
      );

      await onlineRef.onDisconnect().set(false);

      console.log(
        '[FirebaseRoom] Room created:',
        roomCode
      );

      return {
        success: true,
        roomCode: roomCode,
        uid: uid,
        color: COLORS[0],
        isHost: true
      };

    } catch (err) {
      console.error(
        '[FirebaseRoom] createRoom error:',
        err
      );

      if (err && err.message === 'AUTH_REQUIRED') {
        return {
          success: false,
          error: 'AUTH_REQUIRED'
        };
      }

      if (
        err &&
        (
          err.code === 'PERMISSION_DENIED' ||
          err.message === 'PERMISSION_DENIED'
        )
      ) {
        return {
          success: false,
          error: 'PERMISSION_DENIED'
        };
      }

      return {
        success: false,
        error: 'UNKNOWN_ERROR',
        details: err ? err.message : 'Unknown error'
      };
    }
  }

  // --------------------------------------------------
  // JOIN ROOM
  // --------------------------------------------------

  async function joinRoom(roomCodeRaw, playerName) {
    try {
      console.log('[FirebaseRoom] Joining room...');

      const user = await ensureAuth();

      const uid = user.uid;

      const roomCode = normalizeCode(roomCodeRaw);

      const name = cleanName(playerName);

      // Validation
      if (!validRoomCode(roomCode)) {
        return {
          success: false,
          error: 'INVALID_ROOM_CODE'
        };
      }

      if (!validName(name)) {
        return {
          success: false,
          error: 'INVALID_NAME'
        };
      }

      const roomRef = db.ref(
        'rooms/' + roomCode
      );

      const snapshot = await roomRef.once('value');

      const room = snapshot.val();

      if (!room) {
        return {
          success: false,
          error: 'ROOM_NOT_FOUND'
        };
      }

      // ------------------------------------------------
      // Existing players
      // ------------------------------------------------

      const players = room.players || {};

      const maxPlayers = Number(
        room.maxPlayers || 4
      );

      const currentPlayers = Object.keys(players);

      // Already inside room
      if (players[uid]) {
        const existingColor =
          players[uid].color ||
          pickColorFromPlayers(players);

        const playerRef = db.ref(
          'rooms/' +
          roomCode +
          '/players/' +
          uid
        );

        await playerRef.update({
          uid: uid,
          name: name,
          color: existingColor,
          online: true,
          joinedAt: ServerValue.TIMESTAMP
        });

        await db.ref(
          'rooms/' +
          roomCode +
          '/players/' +
          uid +
          '/online'
        ).onDisconnect().set(false);

        console.log(
          '[FirebaseRoom] Existing player reconnected:',
          uid
        );

        return {
          success: true,
          roomCode: roomCode,
          uid: uid,
          color: existingColor,
          isHost: room.hostId === uid
        };
      }

      // Room full
      if (currentPlayers.length >= maxPlayers) {
        return {
          success: false,
          error: 'ROOM_FULL'
        };
      }

      // ------------------------------------------------
      // Automatic color assignment
      // ------------------------------------------------

      const color =
        pickColorFromPlayers(players);

      if (!color) {
        return {
          success: false,
          error: 'ROOM_FULL'
        };
      }

      // ------------------------------------------------
      // Add player
      // ------------------------------------------------

      const playerData = {
        uid: uid,
        name: name,
        color: color,
        online: true,
        joinedAt: ServerValue.TIMESTAMP
      };

      await roomRef
        .child('players')
        .child(uid)
        .set(playerData);

      // ------------------------------------------------
      // Presence
      // ------------------------------------------------

      await db.ref(
        'rooms/' +
        roomCode +
        '/players/' +
        uid +
        '/online'
      ).onDisconnect().set(false);

      console.log(
        '[FirebaseRoom] Joined room:',
        roomCode,
        'Color:',
        color
      );

      return {
        success: true,
        roomCode: roomCode,
        uid: uid,
        color: color,
        isHost: room.hostId === uid
      };

    } catch (err) {
      console.error(
        '[FirebaseRoom] joinRoom error:',
        err
      );

      if (err && err.message === 'AUTH_REQUIRED') {
        return {
          success: false,
          error: 'AUTH_REQUIRED'
        };
      }

      if (
        err &&
        (
          err.code === 'PERMISSION_DENIED' ||
          err.message === 'PERMISSION_DENIED'
        )
      ) {
        return {
          success: false,
          error: 'PERMISSION_DENIED'
        };
      }

      return {
        success: false,
        error: 'UNKNOWN_ERROR',
        details: err ? err.message : 'Unknown error'
      };
    }
  }

  // --------------------------------------------------
  // LEAVE ROOM
  // --------------------------------------------------

  async function leaveRoom(roomCodeRaw) {
    try {
      const user = await ensureAuth();

      const uid = user.uid;

      const roomCode = normalizeCode(roomCodeRaw);

      if (!validRoomCode(roomCode)) {
        return {
          success: false,
          error: 'INVALID_ROOM_CODE'
        };
      }

      const roomRef = db.ref(
        'rooms/' + roomCode
      );

      const snapshot = await roomRef.once('value');

      const room = snapshot.val();

      if (!room) {
        return {
          success: false,
          error: 'ROOM_NOT_FOUND'
        };
      }

      const players = room.players || {};

      if (!players[uid]) {
        return {
          success: false,
          error: 'NOT_IN_ROOM'
        };
      }

      // Mark offline
      await roomRef
        .child('players')
        .child(uid)
        .child('online')
        .set(false);

      // ------------------------------------------------
      // Host transfer
      // ------------------------------------------------

      if (room.hostId === uid) {
        const remaining = Object.values(players)
          .filter(function (player) {
            return player &&
              player.uid !== uid;
          });

        // No players left
        if (remaining.length === 0) {
          await roomRef.remove();

          return {
            success: true,
            roomDeleted: true
          };
        }

        // Oldest remaining player becomes host
        remaining.sort(function (a, b) {
          return (
            Number(a.joinedAt || 0) -
            Number(b.joinedAt || 0)
          );
        });

        const newHost = remaining[0];

        await roomRef
          .child('hostId')
          .set(newHost.uid);

        return {
          success: true,
          newHost: newHost.uid
        };
      }

      return {
        success: true
      };

    } catch (err) {
      console.error(
        '[FirebaseRoom] leaveRoom error:',
        err
      );

      if (err && err.message === 'AUTH_REQUIRED') {
        return {
          success: false,
          error: 'AUTH_REQUIRED'
        };
      }

      return {
        success: false,
        error: 'UNKNOWN_ERROR',
        details: err ? err.message : 'Unknown error'
      };
    }
  }

  // --------------------------------------------------
  // GET ROOM
  // --------------------------------------------------

  async function getRoom(roomCodeRaw) {
    try {
      const roomCode =
        normalizeCode(roomCodeRaw);

      if (!validRoomCode(roomCode)) {
        return null;
      }

      const snapshot = await db
        .ref('rooms/' + roomCode)
        .once('value');

      return snapshot.val();

    } catch (err) {
      console.error(
        '[FirebaseRoom] getRoom error:',
        err
      );

      return null;
    }
  }

  // --------------------------------------------------
  // GET PLAYERS
  // --------------------------------------------------

  async function getPlayers(roomCodeRaw) {
    try {
      const roomCode =
        normalizeCode(roomCodeRaw);

      if (!validRoomCode(roomCode)) {
        return [];
      }

      const snapshot = await db
        .ref(
          'rooms/' +
          roomCode +
          '/players'
        )
        .once('value');

      const playersObj =
        snapshot.val() || {};

      const players =
        Object.values(playersObj);

      players.sort(function (a, b) {
        return (
          Number(a.joinedAt || 0) -
          Number(b.joinedAt || 0)
        );
      });

      return players;

    } catch (err) {
      console.error(
        '[FirebaseRoom] getPlayers error:',
        err
      );

      return [];
    }
  }

  // --------------------------------------------------
  // CURRENT ROOM CODE
  // --------------------------------------------------

  function getRoomCode() {
    return (
      localStorage.getItem('roomCode') ||
      null
    );
  }

  // --------------------------------------------------
  // CURRENT PLAYER
  // --------------------------------------------------

  function getCurrentPlayer() {
    if (!window.FirebaseAuth) {
      return null;
    }

    if (
      typeof window.FirebaseAuth.getUser ===
      'function'
    ) {
      return window.FirebaseAuth.getUser();
    }

    return null;
  }

  // --------------------------------------------------
  // IS HOST
  // --------------------------------------------------

  async function isHost(roomCodeRaw) {
    try {
      const user = await ensureAuth();

      const room =
        await getRoom(roomCodeRaw);

      if (!room) {
        return false;
      }

      return room.hostId === user.uid;

    } catch (err) {
      console.error(
        '[FirebaseRoom] isHost error:',
        err
      );

      return false;
    }
  }

  // --------------------------------------------------
  // ROOM LISTENER
  // --------------------------------------------------

  function onRoomChanged(
    roomCodeRaw,
    callback
  ) {
    const roomCode =
      normalizeCode(roomCodeRaw);

    if (
      !validRoomCode(roomCode) ||
      typeof callback !== 'function'
    ) {
      console.warn(
        '[FirebaseRoom] Invalid onRoomChanged arguments'
      );

      return function () {};
    }

    const ref = db.ref(
      'rooms/' + roomCode
    );

    const listener = function (snapshot) {
      callback(snapshot.val());
    };

    ref.on(
      'value',
      listener
    );

    return function unsubscribe() {
      ref.off(
        'value',
        listener
      );
    };
  }

  // --------------------------------------------------
  // PLAYERS LISTENER
  // --------------------------------------------------

  function onPlayersChanged(
    roomCodeRaw,
    callback
  ) {
    const roomCode =
      normalizeCode(roomCodeRaw);

    if (
      !validRoomCode(roomCode) ||
      typeof callback !== 'function'
    ) {
      console.warn(
        '[FirebaseRoom] Invalid onPlayersChanged arguments'
      );

      return function () {};
    }

    const ref = db.ref(
      'rooms/' +
      roomCode +
      '/players'
    );

    const listener = function (snapshot) {
      const playersObj =
        snapshot.val() || {};

      const players =
        Object.values(playersObj);

      players.sort(function (a, b) {
        return (
          Number(a.joinedAt || 0) -
          Number(b.joinedAt || 0)
        );
      });

      callback(players);
    };

    ref.on(
      'value',
      listener
    );

    return function unsubscribe() {
      ref.off(
        'value',
        listener
      );
    };
  }

  // --------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------

  window.FirebaseRoom = {
    createRoom: createRoom,
    joinRoom: joinRoom,
    leaveRoom: leaveRoom,

    getRoom: getRoom,
    getPlayers: getPlayers,

    getRoomCode: getRoomCode,
    getCurrentPlayer: getCurrentPlayer,

    isHost: isHost,

    onRoomChanged: onRoomChanged,
    onPlayersChanged: onPlayersChanged
  };

  console.log(
    '[FirebaseRoom] Module loaded successfully'
  );

})();
