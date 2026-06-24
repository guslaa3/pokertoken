(function(){
  let state = { buyIn: 0, pot: 0, players: [] };
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  // Identity persisted in sessionStorage so a refresh doesn't lose "who am I"
  let myRoom = null;
  let myPlayerId = null;
  let myPlayerToken = null;
  let myHostToken = null;
  let amIHost = false;

  const $ = (id) => document.getElementById(id);
  const playerList = $('playerList');
  const potAmountEl = $('potAmount');
  const buyinTag = $('buyinTag');
  const toastEl = $('toast');
  const syncDot = $('syncDot');
  const syncText = $('syncText');
  const hostPanel = $('hostPanel');

  function showToast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(()=> toastEl.classList.remove('show'), 2200);
  }

  function chipSVG(color){
    return `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
      <circle cx="20" cy="20" r="18" fill="${color}" stroke="#00000022" stroke-width="1"/>
      <circle cx="20" cy="20" r="18" fill="none" stroke="#FFFFFF33" stroke-width="2" stroke-dasharray="4 5"/>
      <circle cx="20" cy="20" r="11" fill="none" stroke="#FFFFFF55" stroke-width="1.5"/>
    </svg>`;
  }

  function colorForBalance(balance, buyIn){
    if(balance > buyIn) return 'var(--success)';
    if(balance < buyIn) return 'var(--chip-red)';
    return 'var(--gold)';
  }

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function render(){
    potAmountEl.textContent = state.pot.toLocaleString();
    buyinTag.textContent = '시작 토큰 ' + state.buyIn.toLocaleString();
    hostPanel.style.display = amIHost ? 'block' : 'none';

    if(state.players.length === 0){
      playerList.innerHTML = `<div class="empty-state">플레이어를 기다리는 중...</div>`;
      return;
    }

    playerList.innerHTML = state.players.map(p => {
      const isMe = p.id === myPlayerId;
      const canBet = isMe && p.balance > 0;
      return `
      <div class="player-card ${isMe ? 'me' : ''} ${p.balance === 0 ? 'zero' : ''}" data-id="${p.id}">
        <div class="player-top">
          <div class="player-id">
            <div class="chip-stack">${chipSVG(colorForBalance(p.balance, state.buyIn))}</div>
            <span class="player-name">${escapeHtml(p.name)}</span>
            ${isMe ? '<span class="me-tag">나</span>' : ''}
          </div>
        </div>
        <div class="player-stack-row">
          <div class="stack-amount display">${p.balance.toLocaleString()}</div>
        </div>
        ${isMe ? `
        <div class="bet-row">
          <button class="bet-btn" data-action="bet" data-amt="100" ${p.balance < 100 ? 'disabled' : ''}>100</button>
          <button class="bet-btn" data-action="bet" data-amt="500" ${p.balance < 500 ? 'disabled' : ''}>500</button>
          <button class="bet-btn" data-action="bet" data-amt="1000" ${p.balance < 1000 ? 'disabled' : ''}>1000</button>
          <button class="bet-btn allin" data-action="allin" ${p.balance <= 0 ? 'disabled' : ''}>올인</button>
        </div>` : ''}
      </div>`;
    }).join('');
  }

  // ===== WebSocket =====
  function wsUrl(){
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  function connect(){
    if(ws){ ws.onclose = null; ws.close(); }
    syncDot.style.background = 'var(--gold)';
    syncText.textContent = '연결 중...';

    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      reconnectDelay = 1000;
      if(myRoom && myPlayerId && myPlayerToken){
        // Reconnecting with existing identity (e.g. after a refresh)
        ws.send(JSON.stringify({
          type: 'rejoin', room: myRoom, playerId: myPlayerId,
          playerToken: myPlayerToken, hostToken: myHostToken || undefined
        }));
      } else if(pendingAction){
        ws.send(JSON.stringify(pendingAction));
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try{ msg = JSON.parse(event.data); }catch(e){ return; }

      if(msg.type === 'joined'){
        myRoom = msg.room;
        myPlayerId = msg.playerId;
        myPlayerToken = msg.playerToken;
        amIHost = !!msg.isHost;
        if(msg.hostToken) myHostToken = msg.hostToken;
        persistIdentity();
        state = msg.state;
        showApp();
        render();
        syncDot.style.background = 'var(--success)';
        syncText.textContent = '실시간 동기화 중';
        pendingAction = null;
      } else if(msg.type === 'state'){
        state = msg.state;
        render();
      } else if(msg.type === 'error'){
        showToast(msg.message || '오류가 발생했어요');
      }
    };

    ws.onclose = () => {
      syncDot.style.background = 'var(--danger)';
      syncText.textContent = '연결 끊김 — 재연결 중';
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
    };

    ws.onerror = () => {
      syncDot.style.background = 'var(--danger)';
      syncText.textContent = '동기화 실패 — 인터넷 연결 확인 필요';
    };
  }

  let pendingAction = null;

  function send(payload){
    if(ws && ws.readyState === WebSocket.OPEN){
      ws.send(JSON.stringify(payload));
    } else {
      showToast('동기화 실패 — 연결을 확인해주세요');
    }
  }

  // ===== Identity persistence (sessionStorage: survives refresh, not new device) =====
  function persistIdentity(){
    try{
      sessionStorage.setItem('tokenCounter_identity', JSON.stringify({
        room: myRoom, playerId: myPlayerId, playerToken: myPlayerToken,
        hostToken: myHostToken, isHost: amIHost
      }));
    }catch(e){}
  }
  function loadIdentity(){
    try{
      const raw = sessionStorage.getItem('tokenCounter_identity');
      if(!raw) return false;
      const d = JSON.parse(raw);
      myRoom = d.room; myPlayerId = d.playerId; myPlayerToken = d.playerToken;
      myHostToken = d.hostToken; amIHost = !!d.isHost;
      return !!(myRoom && myPlayerId && myPlayerToken);
    }catch(e){ return false; }
  }

  // ===== Actions =====
  function placeBet(amount, allIn){
    send({ type: 'bet', amount, allIn: !!allIn });
  }

  function declareWinner(winnerId){
    send({ type: 'declare_winner', winnerId });
  }

  // ===== Winner modal (host only) =====
  function openWinnerModal(){
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>승자 지정</h2>
        <div class="sub">현재 팟 ${state.pot.toLocaleString()} 전액이 선택한 플레이어에게 지급돼요</div>
        ${state.players.map(p => `
          <div class="winner-option" data-id="${p.id}">
            <span>${escapeHtml(p.name)}</span>
            <span class="bal">${p.balance.toLocaleString()}</span>
          </div>
        `).join('')}
        <button class="btn btn-ghost modal-close" id="closeWinnerModalBtn">취소</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });
    $('closeWinnerModalBtn').onclick = () => overlay.remove();
    overlay.querySelectorAll('.winner-option').forEach(el => {
      el.addEventListener('click', () => {
        if(state.pot <= 0){ showToast('팟에 베팅된 토큰이 없어요'); overlay.remove(); return; }
        declareWinner(el.dataset.id);
        overlay.remove();
      });
    });
  }

  // ===== Event delegation =====
  playerList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if(!btn || btn.disabled) return;
    const action = btn.dataset.action;
    if(action === 'bet'){
      placeBet(parseInt(btn.dataset.amt, 10), false);
    } else if(action === 'allin'){
      placeBet(null, true);
    }
  });

  $('openWinnerModalBtn').onclick = () => {
    if(state.players.length === 0){ showToast('플레이어가 없어요'); return; }
    openWinnerModal();
  };

  $('copyLinkBtn').onclick = () => {
    const url = `${location.origin}${location.pathname}?room=${myRoom}`;
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(url).then(() => showToast('링크를 복사했어요'));
    } else {
      showToast(url);
    }
  };

  // ===== Join screen =====
  function showApp(){
    $('joinScreen').style.display = 'none';
    $('app').style.display = 'block';
    $('roomCodeDisplay').textContent = myRoom;
  }

  $('tabCreate').onclick = () => {
    $('tabCreate').classList.add('active');
    $('tabJoin').classList.remove('active');
    $('paneCreate').classList.add('active');
    $('paneJoin').classList.remove('active');
  };
  $('tabJoin').onclick = () => {
    $('tabJoin').classList.add('active');
    $('tabCreate').classList.remove('active');
    $('paneJoin').classList.add('active');
    $('paneCreate').classList.remove('active');
  };

  $('createBtn').onclick = () => {
    const name = $('hostNameInput').value.trim();
    const buyIn = parseInt($('buyInInput').value, 10);
    if(!name){ showToast('이름을 입력해주세요'); return; }
    if(isNaN(buyIn) || buyIn <= 0){ showToast('시작 토큰 금액을 입력해주세요'); return; }
    pendingAction = { type: 'create_room', name, buyIn };
    if(ws && ws.readyState === WebSocket.OPEN){ send(pendingAction); } else { connect(); }
  };

  $('joinBtn').onclick = () => {
    const room = $('roomCodeInput').value.trim();
    const name = $('playerNameInput').value.trim();
    if(!room){ showToast('방 코드를 입력해주세요'); return; }
    if(!name){ showToast('이름을 입력해주세요'); return; }
    pendingAction = { type: 'join_room', room, name };
    if(ws && ws.readyState === WebSocket.OPEN){ send(pendingAction); } else { connect(); }
  };

  // Auto-fill room code from URL (?room=XXXX) and switch to join tab
  (function prefillFromUrl(){
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if(room){
      $('roomCodeInput').value = room.toUpperCase();
      $('tabJoin').click();
    }
  })();

  // Resume existing session if we have one (e.g. refresh mid-game)
  if(loadIdentity()){
    connect();
  }
})();
