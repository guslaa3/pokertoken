(function(){
  let state = { buyIn: 0, ante: 0, pot: 0, pendingBet: 0, turnPlayerId: null, players: [] };
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  let myRoom = null;
  let myPlayerId = null;
  let myPlayerToken = null;
  let myHostToken = null;
  let amIHost = false;
  let pendingAction = null;

  const $ = (id) => document.getElementById(id);
  const playerList = $('playerList');
  const potAmountEl = $('potAmount');
  const buyinTag = $('buyinTag');
  const toastEl = $('toast');
  const syncDot = $('syncDot');
  const syncText = $('syncText');
  const hostPanel = $('hostPanel');
  const turnBanner = $('turnBanner');
  const turnBannerName = $('turnBannerName');

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
    buyinTag.textContent = `보유 ${state.buyIn.toLocaleString()} · 입장료 ${state.ante.toLocaleString()}`;
    hostPanel.style.display = amIHost ? 'block' : 'none';

    const turnPlayer = state.players.find(p => p.id === state.turnPlayerId);
    if(turnPlayer){
      const isMyTurn = state.turnPlayerId === myPlayerId;
      turnBanner.classList.toggle('me', isMyTurn);
      turnBannerName.textContent = turnPlayer.name;
      turnBannerName.classList.toggle('youtag', isMyTurn);
    } else {
      turnBanner.classList.remove('me');
      turnBannerName.textContent = '대기 중';
      turnBannerName.classList.remove('youtag');
    }

    if(state.players.length === 0){
      playerList.innerHTML = `<div class="empty-state">플레이어를 기다리는 중...</div>`;
      return;
    }

    playerList.innerHTML = state.players.map(p => {
      const isMe = p.id === myPlayerId;
      const isTurn = p.id === state.turnPlayerId;
      const cardClasses = [
        'player-card',
        isMe ? 'me' : '',
        p.bankrupt ? 'bankrupt' : '',
        p.folded ? 'folded' : '',
        isTurn ? 'its-turn' : '',
      ].filter(Boolean).join(' ');

      let controlsHtml = '';
      if(isMe && isTurn && !p.bankrupt && !p.folded){
        const avail = p.balance - state.pendingBet;
        controlsHtml = `
        <div class="pending-row">
          <span>지금 베팅 중인 금액</span>
          <span class="val">${state.pendingBet.toLocaleString()}</span>
        </div>
        <div class="bet-row">
          <button class="bet-btn" data-action="stage" data-amt="100" ${avail < 100 ? 'disabled' : ''}>100</button>
          <button class="bet-btn" data-action="stage" data-amt="500" ${avail < 500 ? 'disabled' : ''}>500</button>
          <button class="bet-btn" data-action="stage" data-amt="1000" ${avail < 1000 ? 'disabled' : ''}>1000</button>
          <button class="bet-btn allin" data-action="allin" ${avail <= 0 ? 'disabled' : ''}>올인</button>
        </div>
        ${state.pendingBet <= 0 ? `
        <div class="confirm-row">
          <button class="btn btn-ghost check-btn" data-action="check">체크</button>
          <button class="btn btn-ghost fold-btn" data-action="fold">다이</button>
        </div>` : `
        <div class="confirm-row">
          <button class="btn btn-ghost" data-action="reset">초기화</button>
          <button class="btn btn-gold" data-action="confirm">베팅 확정</button>
        </div>
        <div class="confirm-row">
          <button class="btn btn-ghost fold-btn" data-action="fold">다이</button>
        </div>`}`;
      } else if(isMe && !isTurn && !p.bankrupt && !p.folded){
        controlsHtml = p.balance <= 0
          ? `<div class="pending-row"><span>베팅할 토큰이 없어 자동으로 차례가 넘어가요</span></div>`
          : `<div class="pending-row"><span>내 차례를 기다리는 중...</span></div>`;
      } else if(isMe && p.folded && !p.bankrupt){
        controlsHtml = `<div class="pending-row"><span>이번 판은 다이했어요. 다음 판부터 다시 참여해요</span></div>`;
      }

      return `
      <div class="${cardClasses}" data-id="${p.id}">
        <div class="player-top">
          <div class="player-id">
            <div class="chip-stack">${chipSVG(colorForBalance(p.balance, state.buyIn))}</div>
            <span class="player-name">${escapeHtml(p.name)}</span>
            ${isMe ? '<span class="me-tag">나</span>' : ''}
            ${isTurn && !p.bankrupt && !p.folded ? '<span class="turn-tag">차례</span>' : ''}
            ${p.folded && !p.bankrupt ? '<span class="fold-tag">다이</span>' : ''}
            ${p.bankrupt ? '<span class="bankrupt-tag">파산</span>' : ''}
          </div>
        </div>
        <div class="player-stack-row">
          <div class="stack-amount display">${p.balance.toLocaleString()}</div>
        </div>
        ${controlsHtml}
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

  function send(payload){
    if(ws && ws.readyState === WebSocket.OPEN){
      ws.send(JSON.stringify(payload));
    } else {
      showToast('동기화 실패 — 연결을 확인해주세요');
    }
  }

  // ===== Identity persistence =====
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
  function stageBet(amount, allIn){
    send({ type: 'stage_bet', amount, allIn: !!allIn });
  }
  function resetPending(){
    send({ type: 'reset_pending' });
  }
  function confirmBet(){
    send({ type: 'confirm_bet' });
  }
  function checkTurn(){
    send({ type: 'check' });
  }
  function foldTurn(){
    send({ type: 'fold' });
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
        <div class="sub">현재 팟 ${state.pot.toLocaleString()} 전액이 선택한 플레이어에게 지급되고, 다음 판은 그 사람부터 시작해요</div>
        ${state.players.map(p => `
          <div class="winner-option ${p.folded ? 'disabled' : ''}" data-id="${p.id}" data-folded="${!!p.folded}">
            <span>${escapeHtml(p.name)}${p.bankrupt ? ' (파산)' : ''}${p.folded ? ' (다이)' : ''}</span>
            <span class="bal">${p.balance.toLocaleString()}</span>
          </div>
        `).join('')}
        <button class="btn btn-ghost modal-close" id="closeWinnerModalBtn">취소</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });
    $('closeWinnerModalBtn').onclick = () => overlay.remove();
    overlay.querySelectorAll('.winner-option').forEach(el => {
      if(el.dataset.folded === 'true'){
        el.addEventListener('click', () => showToast('다이한 플레이어는 승자로 지정할 수 없어요'));
        return;
      }
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
    if(action === 'stage'){
      stageBet(parseInt(btn.dataset.amt, 10), false);
    } else if(action === 'allin'){
      stageBet(null, true);
    } else if(action === 'reset'){
      resetPending();
    } else if(action === 'confirm'){
      confirmBet();
    } else if(action === 'check'){
      checkTurn();
    } else if(action === 'fold'){
      foldTurn();
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
    const anteRaw = $('anteInput').value.trim();
    const ante = anteRaw === '' ? 0 : parseInt(anteRaw, 10);
    if(!name){ showToast('이름을 입력해주세요'); return; }
    if(isNaN(buyIn) || buyIn <= 0){ showToast('보유 금액을 입력해주세요'); return; }
    if(isNaN(ante) || ante < 0){ showToast('입장료를 올바르게 입력해주세요'); return; }
    if(ante > buyIn){ showToast('입장료가 보유 금액보다 클 수 없어요'); return; }
    pendingAction = { type: 'create_room', name, buyIn, ante };
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

  (function prefillFromUrl(){
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if(room){
      $('roomCodeInput').value = room.toUpperCase();
      $('tabJoin').click();
    }
  })();

  if(loadIdentity()){
    connect();
  }
})();
