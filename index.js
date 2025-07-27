const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Chess } = require('chess.js');

// --- CÓDIGO PARA FIREBASE ---
const admin = require('firebase-admin');

const serviceAccount = require('./ajedrez-juvenil-la-zubia-firebase-adminsdk-fbsvc-bc9893406c.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
// --- FIN CÓDIGO PARA FIREBASE ---


const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const frontendPath = path.join(__dirname, '..');
app.use(express.static(frontendPath));

app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// rooms ahora es un objeto que almacena el estado de cada sala
const rooms = {};

// Constantes para el tiempo de las partidas
const GAME_TIME_SECONDS = 8 * 60; // 8 minutos
const INCREMENT_SECONDS = 3; // 3 segundos de incremento

io.on('connection', (socket) => {
    console.log(`Servidor: Un usuario se ha conectado: ${socket.id}`);

    socket.on('joinRoom', async (roomCode) => {
        let room;

        if (!rooms[roomCode]) {
            // Si la sala no existe en memoria, intenta cargarla de Firestore
            const gameDocRef = db.collection('games').doc(roomCode);
            const gameDoc = await gameDocRef.get();

            if (gameDoc.exists) {
                const gameData = gameDoc.data();
                const initialFen = typeof gameData.fen === 'string' ? gameData.fen : null;
                
                let chessInstance;
                try {
                    chessInstance = new Chess(initialFen);
                    console.log(`Servidor: Partida ${roomCode} cargada desde FEN: ${initialFen}`);
                } catch (e) {
                    console.error(`Servidor: ERROR: FEN inválido para sala ${roomCode}: "${initialFen}". Creando nueva partida de ajedrez.`);
                    chessInstance = new Chess();
                    // Opcional: Actualizar el FEN inválido en Firestore
                    await gameDocRef.update({ fen: chessInstance.fen(), pgn: chessInstance.pgn() });
                }

                room = {
                    players: gameData.players || [], // Cargar jugadores existentes
                    game: chessInstance, // Instancia de chess.js
                    firestoreDocRef: gameDocRef, // Referencia al documento en Firestore
                    // Añadir estado del temporizador. Si existe en Firestore, úsalo, si no, inicializa.
                    timers: gameData.timers || { white: GAME_TIME_SECONDS, black: GAME_TIME_SECONDS },
                    timerInterval: null // Para manejar el intervalo del temporizador en el servidor
                };
                rooms[roomCode] = room;
                console.log(`Servidor: Sala ${roomCode} cargada desde Firestore.`);
            } else {
                // Crear nueva sala si no existe en memoria ni en Firestore
                room = {
                    players: [],
                    game: new Chess(),
                    firestoreDocRef: gameDocRef,
                    timers: { white: GAME_TIME_SECONDS, black: GAME_TIME_SECONDS }, // Tiempo inicial
                    timerInterval: null
                };
                rooms[roomCode] = room;
                console.log(`Servidor: Sala ${roomCode} creada (nueva partida).`);
                await gameDocRef.set({
                    fen: room.game.fen(),
                    pgn: room.game.pgn(),
                    players: [], // Se actualizará al unirse los jugadores
                    status: 'waiting',
                    timers: room.timers, // Guardar tiempos iniciales
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        } else {
            room = rooms[roomCode];
        }

        if (!room) {
            console.error(`Servidor: ERROR: No se pudo obtener la referencia de la sala ${roomCode}.`);
            socket.emit('roomError', 'No se pudo unir a la sala. Inténtalo de nuevo.');
            return;
        }

        // Si el jugador ya está en la sala, simplemente lo resincronizamos
        if (room.players.includes(socket.id)) {
            console.log(`Servidor: Jugador ${socket.id} ya está en la sala ${roomCode}. Resincronizando.`);
            let playerColorAlreadyAssigned = room.players[0] === socket.id ? 'w' : (room.players[1] === socket.id ? 'b' : null);
            socket.emit('roomJoined', { 
                roomCode, 
                playerColor: playerColorAlreadyAssigned,
                playersCount: room.players.length, // Para que el cliente sepa si el temporizador debe iniciar
                timers: room.timers // Enviar tiempos actuales
            });
            if (room.players.length === 2) { // Si la sala ya tiene 2 jugadores y se está resincronizando
                socket.emit('gameStart', room.game.fen());
            }
            return;
        }

        // Verificar si la sala está llena
        if (room.players.length >= 2) {
            socket.emit('roomFull', roomCode);
            console.log(`Servidor: Intento de unirse a sala llena: ${roomCode} por ${socket.id}`);
            return;
        }

        // Asignar color al jugador
        let playerColor;
        if (room.players.length === 0) {
            playerColor = 'w';
        } else {
            playerColor = 'b';
        }

        room.players.push(socket.id);
        socket.join(roomCode); // Une el socket a la sala de Socket.IO

        // Actualizar los jugadores en Firestore
        await room.firestoreDocRef.update({
            players: room.players,
            // Si la partida se carga desde Firestore y tiene jugadores, actualiza el estado si estaba en 'waiting'
            status: room.players.length === 2 ? 'ongoing' : 'waiting'
        });

        socket.emit('roomJoined', { 
            roomCode, 
            playerColor,
            playersCount: room.players.length, // Para que el cliente sepa si el temporizador debe iniciar
            timers: room.timers // Enviar tiempos iniciales
        });
        console.log(`Servidor: Jugador ${socket.id} unido a la sala ${roomCode} como ${playerColor}`);

        // Si hay 2 jugadores, iniciar la partida
        if (room.players.length === 2) {
            console.log(`Servidor: Partida iniciada en sala ${roomCode}`);
            io.to(roomCode).emit('gameStart', room.game.fen());
            await room.firestoreDocRef.update({ status: 'ongoing' });
            startServerTimer(roomCode); // Iniciar el temporizador del servidor
        }
    });

    // --- Lógica del Temporizador del Servidor ---
    function startServerTimer(roomCode) {
        const room = rooms[roomCode];
        if (!room || room.timerInterval) return; // Ya está corriendo o la sala no existe

        console.log(`Servidor: Iniciando temporizador para sala ${roomCode}.`);
        room.timerInterval = setInterval(async () => {
            if (!room.game) { // Si la instancia de juego no está disponible por alguna razón
                stopServerTimer(roomCode);
                return;
            }

            const currentTurn = room.game.turn();
            if (currentTurn === 'w') {
                room.timers.white--;
            } else {
                room.timers.black--;
            }

            // Notificar a los clientes sobre la actualización del tiempo para sincronización visual
            // Aunque el cliente tenga su propio contador, esta es la fuente de verdad.
            io.to(roomCode).emit('timerUpdate', room.timers); 

            if (room.timers.white <= 0 || room.timers.black <= 0) {
                stopServerTimer(roomCode);
                const winner = room.timers.white <= 0 ? 'b' : 'w';
                io.to(roomCode).emit('gameOver', winner, 'timeout'); // Notifica a los clientes el fin por tiempo
                console.log(`Servidor: Fin de partida en sala ${roomCode} por tiempo. Ganador: ${winner}`);

                await room.firestoreDocRef.update({
                    status: 'timeout',
                    winner: winner,
                    fen: room.game.fen(), // Guardar el FEN final
                    pgn: room.game.pgn(), // Guardar el PGN final
                    endedAt: admin.firestore.FieldValue.serverTimestamp(),
                    timers: room.timers // Guarda el tiempo final
                });
                delete rooms[roomCode]; // Limpiar la sala del servidor
            }
        }, 1000); // Se ejecuta cada segundo
    }

    function stopServerTimer(roomCode) {
        const room = rooms[roomCode];
        if (room && room.timerInterval) {
            clearInterval(room.timerInterval);
            room.timerInterval = null;
            console.log(`Servidor: Temporizador detenido para sala ${roomCode}.`);
        }
    }
    // --- Fin Lógica del Temporizador del Servidor ---


    socket.on('makeMove', async (move, roomCode) => {
        const room = rooms[roomCode];
        if (!room || !room.game) {
            console.error(`Servidor: ERROR: Sala ${roomCode} o instancia de juego no encontrada/válida para movimiento de socket ${socket.id}.`);
            socket.emit('gameError', 'La partida no está disponible.');
            return;
        }

        const playerColor = room.players[0] === socket.id ? 'w' : 'b';
        console.log(`Servidor: Intento de movimiento en sala ${roomCode} por ${socket.id} (Color: ${playerColor}). Turno actual del juego: ${room.game.turn()}`);
        console.log(`Servidor: Movimiento propuesto: ${JSON.stringify(move)}`);

        if (playerColor !== room.game.turn()) {
            console.warn(`Servidor: WARN: Movimiento ILEGAL. No es el turno de ${playerColor} (socket ${socket.id}) en sala ${roomCode}. Turno actual: ${room.game.turn()}`);
            return;
        }

        const result = room.game.move(move); // Realiza el movimiento en la instancia de chess.js

        if (result) {
            console.log(`Servidor: INFO: Movimiento LEGAL en sala ${roomCode}: ${result.from}-${result.to} (${result.san}) por ${playerColor}. Nuevo FEN: ${room.game.fen()}`);
            
            // Aplicar incremento de tiempo al jugador que acaba de mover
            if (result.color === 'w') { // result.color es el color de la pieza que se movió
                room.timers.white += INCREMENT_SECONDS;
            } else {
                room.timers.black += INCREMENT_SECONDS;
            }

            // Emite el movimiento al otro jugador en la sala
            io.to(roomCode).emit('moveMade', result); // Envía el objeto de movimiento completo que devuelve game.move()
            io.to(roomCode).emit('timerUpdate', room.timers); // Enviar la actualización de los tiempos inmediatamente

            // Verificar el estado de la partida (jaque mate, tablas, etc.)
            let gameStatus = 'ongoing';
            let winner = null;

            if (room.game.in_checkmate()) {
                gameStatus = 'checkmate';
                winner = room.game.turn() === 'w' ? 'b' : 'w'; // El turno ya ha cambiado, por eso es el opuesto
                console.log(`Servidor: Jaque Mate en sala ${roomCode}. Ganador: ${winner}`);
            } else if (room.game.in_draw() || room.game.in_stalemate() || room.game.in_threefold_repetition() || room.game.insufficient_material()) {
                gameStatus = 'draw';
                console.log(`Servidor: Tablas en sala ${roomCode}.`);
            }

            // Actualizar el estado de la partida en Firestore
            await room.firestoreDocRef.update({
                fen: room.game.fen(),
                pgn: room.game.pgn(),
                lastMove: { from: result.from, to: result.to, piece: result.piece, color: result.color, san: result.san },
                timers: room.timers, // Guardar los tiempos actualizados
                status: gameStatus, // Actualizar el estado de la partida
                winner: winner, // Actualizar el ganador si lo hay
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                // Si la partida termina, añade el campo endedAt
                ...(gameStatus !== 'ongoing' && { endedAt: admin.firestore.FieldValue.serverTimestamp() })
            });

            if (gameStatus !== 'ongoing') {
                stopServerTimer(roomCode); // Detener el temporizador del servidor
            }

        } else {
            console.warn(`Servidor: WARN: Movimiento ILEGAL recibido en sala ${roomCode}: ${move.from}-${move.to} por ${playerColor}. El resultado de game.move() fue null.`);
        }
    });

    socket.on('resign', async (roomCode, resigningColor) => {
        const room = rooms[roomCode];
        if (!room || !room.game || !room.firestoreDocRef) {
            console.error(`Servidor: ERROR: Sala ${roomCode} o instancia de juego/Firestore no encontrada para rendición.`);
            return;
        }
        console.log(`Servidor: Jugador ${resigningColor} ha abandonado en sala ${roomCode} (desde ${socket.id})`);
        socket.to(roomCode).emit('opponentResigned', resigningColor); // Notifica al oponente
        io.to(roomCode).emit('gameOver', (resigningColor === 'w' ? 'b' : 'w'), 'resignation'); // Notifica a todos el fin de juego

        const winner = resigningColor === 'w' ? 'b' : 'w';
        await room.firestoreDocRef.update({
            status: 'resigned',
            winner: winner,
            fen: room.game.fen(), // Guardar el FEN final
            pgn: room.game.pgn(), // Guardar el PGN final
            endedAt: admin.firestore.FieldValue.serverTimestamp(),
            timers: room.timers // Guarda el tiempo final
        });

        stopServerTimer(roomCode); // Detener el temporizador del servidor
        delete rooms[roomCode]; // Limpiar la sala del servidor
        console.log(`Servidor: Sala ${roomCode} eliminada de la memoria tras rendición.`);
    });

    socket.on('offerDraw', async (roomCode, offererColor) => {
        const room = rooms[roomCode];
        if (!room || !room.game) {
            console.error(`Servidor: ERROR: Sala ${roomCode} o instancia de juego no encontrada para oferta de tablas.`);
            return;
        }
        console.log(`Servidor: Jugador ${offererColor} ofrece tablas en sala ${roomCode} (desde ${socket.id})`);
        
        // Enviar la oferta al otro jugador en la sala (excluyendo al remitente)
        io.to(roomCode).except(socket.id).emit('drawOffer', offererColor);
    });

    socket.on('acceptDraw', async (roomCode) => {
        const room = rooms[roomCode];
        if (!room || !room.game || !room.firestoreDocRef) {
            console.error(`Servidor: ERROR: Sala ${roomCode} o instancia de juego/Firestore no encontrada para aceptación de tablas.`);
            return;
        }
        console.log(`Servidor: Tablas aceptadas en sala ${roomCode} por ${socket.id}`);
        // Notificar a todos en la sala (incluyendo al que aceptó y al que ofreció)
        io.to(roomCode).emit('drawAccepted');
        io.to(roomCode).emit('gameOver', 'draw', 'agreement'); // Notifica a todos el fin de juego

        await room.firestoreDocRef.update({
            status: 'draw',
            fen: room.game.fen(), // Guardar el FEN final
            pgn: room.game.pgn(), // Guardar el PGN final
            endedAt: admin.firestore.FieldValue.serverTimestamp(),
            timers: room.timers // Guarda el tiempo final
        });
        stopServerTimer(roomCode); // Detener el temporizador del servidor
        delete rooms[roomCode]; // Limpiar la sala del servidor
        console.log(`Servidor: Sala ${roomCode} eliminada de la memoria tras tablas.`);
    });

    socket.on('rejectDraw', async (roomCode) => {
        const room = rooms[roomCode];
        if (!room || !room.game) {
            console.error(`Servidor: ERROR: Sala ${roomCode} o instancia de juego no encontrada para rechazo de tablas.`);
            return;
        }
        console.log(`Servidor: Tablas rechazadas en sala ${roomCode} por ${socket.id}`);
        // Notificar solo al jugador que ofreció las tablas
        socket.to(roomCode).emit('drawRejected');
    });

    // Nuevo: Evento para el chat
    socket.on('chatMessage', (roomCode, senderColor, message) => {
        console.log(`Servidor: Mensaje de chat en sala ${roomCode} de ${senderColor}: "${message}"`);
        io.to(roomCode).emit('chatMessage', senderColor, message);
    });

    // Nuevo: Evento para cuando el cliente reporta que la partida terminó por su cuenta (e.g., timeout en cliente, aunque el servidor ya lo maneja)
    socket.on('gameOverClient', async (roomCode, winner, reason) => {
        const room = rooms[roomCode];
        if (!room || !room.game || !room.firestoreDocRef) {
            console.error(`Servidor: ERROR: Sala ${roomCode} o instancia de juego/Firestore no encontrada para gameOverClient.`);
            return;
        }
        console.log(`Servidor: Cliente reporta fin de partida en sala ${roomCode}. Ganador: ${winner}, Razón: ${reason}`);
        // Solo actualizar si el estado en Firestore no es ya final (e.g., 'checkmate', 'draw', 'resigned', 'timeout')
        const gameData = (await room.firestoreDocRef.get()).data();
        if (gameData && (gameData.status === 'ongoing' || gameData.status === 'waiting')) {
            await room.firestoreDocRef.update({
                status: reason, // 'timeout', 'checkmate', etc.
                winner: winner,
                fen: room.game.fen(),
                pgn: room.game.pgn(),
                endedAt: admin.firestore.FieldValue.serverTimestamp(),
                timers: room.timers
            });
            stopServerTimer(roomCode);
            io.to(roomCode).emit('gameOver', winner, reason); // Asegúrate de que todos los clientes lo sepan
            delete rooms[roomCode];
            console.log(`Servidor: Sala ${roomCode} eliminada de la memoria tras fin de partida reportado por cliente.`);
        }
    });


    socket.on('disconnect', async () => {
        console.log(`Servidor: Un usuario se ha desconectado: ${socket.id}`);
        // Encuentra la sala a la que pertenecía el socket desconectado
        const roomCode = Object.keys(rooms).find(code => rooms[code].players.includes(socket.id));

        if (roomCode) {
            const room = rooms[roomCode];
            const playerIndex = room.players.indexOf(socket.id);
            if (playerIndex > -1) {
                room.players.splice(playerIndex, 1); // Eliminar al jugador de la sala

                console.log(`Servidor: Jugador ${socket.id} ha salido de la sala ${roomCode}. Jugadores restantes: ${room.players.length}`);

                if (room.players.length === 0) {
                    // Si no quedan jugadores, marcar la partida como abandonada en Firestore y eliminar de la memoria
                    if (room.firestoreDocRef) {
                        const gameData = (await room.firestoreDocRef.get()).data();
                        if (gameData && (gameData.status === 'ongoing' || gameData.status === 'waiting')) {
                            await room.firestoreDocRef.update({
                                status: 'abandoned',
                                endedAt: admin.firestore.FieldValue.serverTimestamp(),
                                timers: room.timers // Guardar el estado final de los tiempos
                            });
                            console.log(`Servidor: Partida ${roomCode} marcada como 'abandonada' en Firestore.`);
                        }
                    }
                    stopServerTimer(roomCode); // Detener el temporizador
                    delete rooms[roomCode];
                    console.log(`Servidor: Sala ${roomCode} eliminada de la memoria del servidor.`);
                } else {
                    // Si queda un jugador, notificarle que el oponente se ha desconectado
                    socket.to(roomCode).emit('opponentDisconnected', 'Tu oponente se ha desconectado. La partida ha terminado.');
                    io.to(roomCode).emit('gameOver', (room.players[0] === socket.id ? 'b' : 'w'), 'opponentDisconnected'); // Notifica a todos el fin de juego
                    stopServerTimer(roomCode); // Detener el temporizador, ya que la partida ha terminado por desconexión
                    
                    // Marcar la partida como abandonada en Firestore si no se hizo antes
                    if (room.firestoreDocRef) {
                        const gameData = (await room.firestoreDocRef.get()).data();
                        if (gameData && (gameData.status === 'ongoing' || gameData.status === 'waiting')) {
                            await room.firestoreDocRef.update({
                                status: 'abandoned_by_disconnect', // Nuevo estado para diferenciar
                                endedAt: admin.firestore.FieldValue.serverTimestamp(),
                                timers: room.timers // Guardar el estado final de los tiempos
                            });
                            console.log(`Servidor: Partida ${roomCode} marcada como 'abandoned_by_disconnect' en Firestore.`);
                        }
                    }
                    delete rooms[roomCode]; // Limpiar la sala del servidor
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Servidor de ajedrez escuchando en el puerto ${PORT}`);
    console.log(`Abre tu navegador en http://localhost:${PORT}`);
});