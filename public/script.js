// Asegúrate de que todas estas variables estén declaradas globalmente o accesibles
// en el ámbito adecuado de tu script.
let socket = null;
let currentRoom = null;
let playerColor = null; // 'w' para blancas, 'b' para negras
let game = new Chess();
let whiteTime = 0; // Tiempo en segundos para las blancas
let blackTime = 0; // Tiempo en segundos para las negras
let timerInterval = null; // Para el contador regresivo del cliente
const increment = 3; // Incremento de segundos por jugada (solo informativo en el cliente)
let currentHistoryIndex = 0; // Para la navegación del historial
let gameHistory = []; // Almacena los movimientos en formato SAN

// Referencias a elementos del DOM
const roomInput = document.getElementById('roomInput');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const playerColorDisplay = document.getElementById('playerColorDisplay');
const roomStatus = document.getElementById('roomStatus');
const whiteTimeDisplay = document.getElementById('whiteTime');
const blackTimeDisplay = document.getElementById('blackTime');
const resignButton = document.getElementById('resignButton');
const drawButton = document.getElementById('drawButton');
const messageInput = document.getElementById('messageInput');
const sendMessageButton = document.getElementById('sendMessageButton');
const chatMessages = document.getElementById('chatMessages');
const boardContainer = document.getElementById('boardContainer');
const historyList = document.getElementById('historyList');
const prevMoveButton = document.getElementById('prevMove');
const nextMoveButton = document.getElementById('nextMove');
const lastMoveButton = document.getElementById('lastMove');
const currentTurnDisplay = document.getElementById('currentTurnDisplay'); // Para mostrar el turno actual


// Estado para la interacción con el tablero
let selectedSquare = null;
let board = null; // La instancia de Chessboard.js

// --- Funciones de Utilidad ---
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds < 10 ? '0' : ''}${remainingSeconds}`;
}

function updateTimersDisplay() {
    whiteTimeDisplay.textContent = formatTime(whiteTime);
    blackTimeDisplay.textContent = formatTime(blackTime);
}

function startClientTimer() {
    if (timerInterval) clearInterval(timerInterval); // Limpia cualquier temporizador existente

    timerInterval = setInterval(() => {
        const currentTurn = game.turn();
        if (currentTurn === 'w') {
            whiteTime--;
        } else {
            blackTime--;
        }

        updateTimersDisplay();

        if (whiteTime <= 0 || blackTime <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
            const winner = whiteTime <= 0 ? 'b' : 'w';
            alert(`¡Tiempo! Ganan las ${winner === 'w' ? 'Blancas' : 'Negras'}`);
            // Aunque el servidor maneja el 'gameOver' por timeout, el cliente puede reportar si lo detecta primero
            socket.emit('gameOverClient', currentRoom, winner, 'timeout');
        }
    }, 1000); // Actualiza cada segundo
}

function stopClientTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function drawBoard() {
    // Si la instancia del tablero no existe, inicialízala
    if (!board) {
        board = Chessboard('board', {
            draggable: true,
            position: game.fen(),
            onDrop: onDrop,
            onDragStart: onDragStart,
            onSnapEnd: onSnapEnd // Necesario para que el tablero se actualice visualmente después de un snap
        });
    } else {
        board.position(game.fen()); // Actualiza la posición si el tablero ya existe
    }
    updateMoveHistoryList(); // Actualiza la lista de movimientos
    updateNavigationButtons(); // Actualiza el estado de los botones de navegación
}

function updateMoveHistoryList() {
    historyList.innerHTML = '';
    gameHistory.forEach((move, index) => {
        const li = document.createElement('li');
        li.textContent = `${Math.floor(index / 2) + 1}. ${index % 2 === 0 ? 'Blancas: ' : 'Negras: '}${move}`;
        li.classList.add('history-item');
        if (index === currentHistoryIndex - 1) { // Resaltar el último movimiento visto
            li.classList.add('current-move');
        }
        historyList.appendChild(li);
    });
    // Desplazarse al último elemento
    historyList.scrollTop = historyList.scrollHeight;
}

function updateNavigationButtons() {
    prevMoveButton.disabled = currentHistoryIndex <= 0;
    nextMoveButton.disabled = currentHistoryIndex >= gameHistory.length;
    lastMoveButton.disabled = currentHistoryIndex === gameHistory.length;
}

function checkGameStatus() {
    if (game.in_checkmate()) {
        const winner = game.turn() === 'w' ? 'Negras' : 'Blancas';
        roomStatus.textContent = `¡Jaque Mate! Ganan las ${winner}.`;
        alert(`¡Jaque Mate! Ganan las ${winner}.`);
        stopClientTimer(); // Detener el temporizador
    } else if (game.in_stalemate()) {
        roomStatus.textContent = "¡Tablas! (Ahogado)";
        alert("¡Tablas! (Ahogado)");
        stopClientTimer();
    } else if (game.in_draw()) {
        roomStatus.textContent = "¡Tablas! (Por repetición, material insuficiente o 50 movimientos)";
        alert("¡Tablas! (Por repetición, material insuficiente o 50 movimientos)");
        stopClientTimer();
    } else if (game.insufficient_material()) {
        roomStatus.textContent = "¡Tablas! (Material Insuficiente)";
        alert("¡Tablas! (Material Insuficiente)");
        stopClientTimer();
    } else if (game.in_threefold_repetition()) {
        roomStatus.textContent = "¡Tablas! (Por triple repetición)";
        alert("¡Tablas! (Por triple repetición)");
        stopClientTimer();
    }
}

// --- Lógica de Chessboard.js y movimientos ---
function onDragStart(source, piece, position, orientation) {
    if (game.game_over() || piece.search(playerColor) === -1) {
        return false;
    }
}

function onDrop(source, target) {
    const moveData = {
        from: source,
        to: target,
        promotion: 'q' // Simplificación: siempre promociona a reina. Podrías añadir un modal.
    };

    // Intenta hacer el movimiento localmente para obtener el 'result' de chess.js
    // Esto es solo para obtener el 'result' y mostrar los posibles movimientos legales para el cliente local
    // El movimiento real y la validación final se harán en el servidor.
    let tempGame = new Chess(game.fen()); // Crea una copia temporal para la validación local
    const result = tempGame.move(moveData); 

    // console.log("Frontend: Movimiento intentado (local):", moveData);
    // console.log("Frontend: Resultado movimiento (local):", result);

    if (result === null) {
        // console.warn("Frontend: Movimiento ilegal localmente. Volviendo pieza.");
        return 'snapback'; // Si el movimiento es ilegal localmente, la pieza vuelve
    }

    // Si el movimiento es legal localmente, lo enviamos al servidor
    // El tablero NO SE ACTUALIZA LOCALMENTE AQUÍ. Se actualizará cuando el servidor envíe 'moveMade'.
    socket.emit('makeMove', moveData, currentRoom);

    // No actualizamos directamente el tablero ni los tiempos aquí.
    // Esperamos la confirmación y los datos actualizados del servidor.
    // El onSnapEnd se encargará del 'snapback' si el servidor lo indica (o si no hay evento 'moveMade').
}

// onSnapEnd se ejecuta después de que una pieza se suelta o "snap" a su posición.
// Si onDrop devolvió 'snapback', este se encargará de la animación.
function onSnapEnd() {
    // Si el servidor envía un 'moveMade', el 'drawBoard()' en ese handler
    // sobrescribirá cualquier estado temporal o incorrecto del cliente.
    // Esto es vital para la sincronización.
    board.position(game.fen()); // Asegura que el tablero refleja el FEN actual (puede ser el viejo si el movimiento fue ilegal)
}


// --- Lógica de Socket.IO ---
function initializeSocketListeners() {
    if (socket) return; // Ya inicializado

    socket = io();

    socket.on('connect', () => {
        console.log('Frontend: Conectado al servidor Socket.IO');
        if (currentRoom) {
            console.log(`Frontend: Intentando reconectar a la sala ${currentRoom}`);
            socket.emit('joinRoom', currentRoom);
        }
    });

    socket.on('roomJoined', (data) => {
        currentRoom = data.roomCode;
        playerColor = data.playerColor;
        whiteTime = data.timers.white; // Sincroniza el tiempo inicial/actual con el servidor
        blackTime = data.timers.black; // Sincroniza el tiempo inicial/actual con el servidor
        updateTimersDisplay();

        document.getElementById('roomSelection').style.display = 'none';
        document.getElementById('gameContainer').style.display = 'block';

        roomCodeDisplay.textContent = currentRoom;
        playerColorDisplay.textContent = `Eres las ${playerColor === 'w' ? 'Blancas' : 'Negras'}`;
        
        // Configura el tablero con la orientación correcta
        board = Chessboard('board', {
            draggable: true,
            position: game.fen(),
            orientation: playerColor === 'w' ? 'white' : 'black',
            onDrop: onDrop,
            onDragStart: onDragStart,
            onSnapEnd: onSnapEnd
        });
        drawBoard(); // Dibuja el tablero por primera vez
        roomStatus.textContent = `Unido a la sala ${currentRoom}. Esperando al oponente...`;
        currentTurnDisplay.textContent = `Es el turno de: ${game.turn() === 'w' ? 'Blancas' : 'Negras'}`;

        if (data.playersCount === 2) {
            // Si ya hay dos jugadores al unirse, la partida ya puede haber comenzado
            roomStatus.textContent = `¡Partida en curso! Es turno de las ${game.turn() === 'w' ? 'Blancas' : 'Negras'}.`;
            startClientTimer(); // Inicia el temporizador del cliente
        }
    });

    socket.on('gameStart', (fen) => {
        console.log('Frontend: Partida iniciada. FEN inicial:', fen);
        game.load(fen);
        drawBoard();
        roomStatus.textContent = `¡Partida iniciada! Es turno de las ${game.turn() === 'w' ? 'Blancas' : 'Negras'}.`;
        currentTurnDisplay.textContent = `Es el turno de: ${game.turn() === 'w' ? 'Blancas' : 'Negras'}`;
        startClientTimer(); // Inicia el temporizador del cliente
    });

    // --- MANEJADOR CLAVE PARA SINCRONIZACIÓN DE TIEMPOS ---
    socket.on('timerUpdate', (serverTimers) => {
        whiteTime = serverTimers.white;
        blackTime = serverTimers.black;
        updateTimersDisplay();
        // console.log(`Frontend: Tiempos actualizados por servidor. Blancas: ${formatTime(whiteTime)}, Negras: ${formatTime(blackTime)}`);
    });

    socket.on('moveMade', (move) => {
        // Siempre aplica el movimiento del servidor para mantener la sincronización
        const prevTurn = game.turn(); // Obtener el turno antes del movimiento
        game.move(move);
        
        // No aplicamos el incremento de tiempo aquí localmente.
        // El evento 'timerUpdate' que llega inmediatamente después ya contendrá el incremento.

        // Añadir al historial
        gameHistory.push(move.san || game.history({ verbose: true }).pop().san);
        currentHistoryIndex = gameHistory.length; // Asegura que se ve el último movimiento

        drawBoard(); // Redibuja el tablero con la nueva posición
        roomStatus.textContent = `Movimiento recibido. Es turno de las ${game.turn() === 'w' ? 'Blancas' : 'Negras'}.`;
        currentTurnDisplay.textContent = `Es el turno de: ${game.turn() === 'w' ? 'Blancas' : 'Negras'}`; // Actualiza el turno
        console.log('Frontend: Movimiento recibido:', move);
        checkGameStatus(); // Verifica si el juego terminó después del movimiento
    });

    socket.on('roomFull', (roomCode) => {
        alert(`La sala ${roomCode} está llena.`);
        console.log(`Frontend: La sala ${roomCode} está llena.`);
        currentRoom = null; // Reiniciar para que el usuario pueda intentar otra sala
        document.getElementById('roomSelection').style.display = 'block';
        document.getElementById('gameContainer').style.display = 'none';
        roomStatus.textContent = 'Por favor, introduce un código de sala o crea uno nuevo.';
    });

    socket.on('opponentDisconnected', (message) => {
        alert(message);
        roomStatus.textContent = message;
        stopClientTimer(); // Detener el temporizador
        // Opcional: Deshabilitar interacciones o limpiar la sala
    });

    socket.on('gameError', (message) => {
        alert(`Error en la partida: ${message}`);
        console.error('Frontend: Error de juego:', message);
    });

    socket.on('gameOver', (winner, reason) => {
        let message = '';
        if (reason === 'timeout') {
            message = `¡Tiempo! Ganan las ${winner === 'w' ? 'Blancas' : 'Negras'}.`;
        } else if (reason === 'resignation') {
            message = `¡Rendición! Ganan las ${winner === 'w' ? 'Blancas' : 'Negras'}.`;
        } else if (reason === 'agreement') {
            message = `¡Tablas por acuerdo!`;
        } else if (reason === 'checkmate') { // Aunque checkGameStatus ya lo maneja
            message = `¡Jaque Mate! Ganan las ${winner === 'w' ? 'Blancas' : 'Negras'}.`;
        } else if (reason === 'draw') { // Aunque checkGameStatus ya lo maneja
            message = `¡Tablas!`;
        } else if (reason === 'opponentDisconnected') {
            message = `Tu oponente se ha desconectado. Partida terminada.`;
        }
        alert(`PARTIDA TERMINADA: ${message}`);
        roomStatus.textContent = `PARTIDA TERMINADA: ${message}`;
        stopClientTimer();
        // Opcional: Deshabilitar el tablero, mostrar un botón para nueva partida, etc.
    });

    socket.on('opponentResigned', (resigningColor) => {
        const winner = resigningColor === 'w' ? 'Negras' : 'Blancas';
        alert(`El jugador ${resigningColor === 'w' ? 'Blancas' : 'Negras'} se ha rendido. ¡Ganan las ${winner}!`);
        roomStatus.textContent = `El jugador ${resigningColor === 'w' ? 'Blancas' : 'Negras'} se ha rendido. ¡Ganan las ${winner}!`;
    });

    socket.on('drawOffer', (offererColor) => {
        const offererName = offererColor === 'w' ? 'Blancas' : 'Negras';
        if (confirm(`${offererName} te ofrece tablas. ¿Aceptas?`)) {
            socket.emit('acceptDraw', currentRoom);
        } else {
            socket.emit('rejectDraw', currentRoom);
        }
    });

    socket.on('drawAccepted', () => {
        alert('¡Tablas aceptadas por el oponente!');
        roomStatus.textContent = '¡Partida finalizada: Tablas por acuerdo!';
    });

    socket.on('drawRejected', () => {
        alert('Tu oferta de tablas ha sido rechazada.');
        roomStatus.textContent = 'Tu oferta de tablas ha sido rechazada. La partida continúa.';
    });

    socket.on('chatMessage', (senderColor, message) => {
        const messageElement = document.createElement('div');
        messageElement.innerHTML = `<strong>${senderColor === 'w' ? 'Blancas' : 'Negras'}:</strong> ${message}`;
        chatMessages.appendChild(messageElement);
        chatMessages.scrollTop = chatMessages.scrollHeight; // Desplazar hacia abajo
    });

    // Nuevo: Manejador para movimientos ilegales reportados por el servidor
    socket.on('invalidMove', (message) => {
        alert(`Movimiento inválido: ${message}`);
        // Forzar al tablero a su posición correcta (la que el servidor tiene)
        board.position(game.fen());
        console.warn(`Frontend: Movimiento inválido reportado por el servidor: ${message}`);
    });

    socket.on('disconnect', () => {
        console.log('Frontend: Desconectado del servidor Socket.IO');
        stopClientTimer(); // Detener el temporizador al desconectarse
        roomStatus.textContent = '¡Desconectado del servidor! Intentando reconectar...';
    });
}


// --- Event Listeners del DOM ---
joinRoomBtn.addEventListener('click', () => {
    const roomCode = roomInput.value.trim();
    if (roomCode) {
        initializeSocketListeners(); // Asegura que los listeners estén listos
        socket.emit('joinRoom', roomCode);
    } else {
        alert('Por favor, introduce un código de sala.');
    }
});

resignButton.addEventListener('click', () => {
    if (currentRoom && confirm('¿Estás seguro de que quieres rendirte?')) {
        socket.emit('resign', currentRoom, playerColor);
    }
});

drawButton.addEventListener('click', () => {
    if (currentRoom && confirm('¿Quieres ofrecer tablas a tu oponente?')) {
        socket.emit('offerDraw', currentRoom, playerColor);
    }
});

sendMessageButton.addEventListener('click', () => {
    const message = messageInput.value.trim();
    if (message && currentRoom) {
        socket.emit('chatMessage', currentRoom, playerColor, message);
        messageInput.value = ''; // Limpiar el input
    }
});

messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessageButton.click();
    }
});

prevMoveButton.addEventListener('click', () => {
    if (currentHistoryIndex > 0) {
        currentHistoryIndex--;
        game.load(game.history({ verbose: true })[currentHistoryIndex - 1] ? game.history({ verbose: true })[currentHistoryIndex - 1].after : game.initialFen());
        board.position(game.fen());
        updateMoveHistoryList();
        updateNavigationButtons();
    }
});

nextMoveButton.addEventListener('click', () => {
    if (currentHistoryIndex < gameHistory.length) {
        currentHistoryIndex++;
        game.load(game.history({ verbose: true })[currentHistoryIndex - 1].after);
        board.position(game.fen());
        updateMoveHistoryList();
        updateNavigationButtons();
    }
});

lastMoveButton.addEventListener('click', () => {
    currentHistoryIndex = gameHistory.length;
    game.load(gameHistory.length > 0 ? game.history({ verbose: true }).pop().after : game.initialFen()); // Cargar el último FEN real
    board.position(game.fen());
    updateMoveHistoryList();
    updateNavigationButtons();
});

// Inicializar el socket al cargar la página (aunque se conectará al intentar unirse a una sala)
// initializeSocketListeners(); // No lo llamamos aquí, sino al hacer click en joinRoomBtn