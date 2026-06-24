(function(){
  let state = { buyIn: 0, pot: 0, players: [] };
  let ws = null;
  let roomCode = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  const $ = (id) => document.getElementById(id);
  const playerList = $('playerList');
  const potAmountEl = $('potAmount');
  const buyinTag = $('buyinTag');
  const toastEl = $('toast');
  const syncDot = $('syncDot');
  const syncText = $('syncText');

  function showToast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(()=> toastEl.classList.remove('show'), 2200);
  }

  function uid(){ return 'p_' + Math.random().toString(36).slice(2,9); }

  function chipSVG(color){
    return `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
      <circle cx="20" cy="20" r="18" fill="${color}" stroke="#00000022" stroke-width="1"/>
      <circle cx="20" cy="20" r="18" fill="none" stroke="#FFFFFF33" stroke-width="2" stroke-dasharray="4 5"/>
      <circle cx="20" cy="20" r="11" fill="none" stroke="#FFFFFF55" stroke-width="1.5"/>
    </svg>`;
  }

  function colorForStack(stack, buyIn){
    if(stack > buyIn) return 'var(--success)';
    if(stack < buyIn) return 'var(--chip-red)';
    return 'var(--gold)';
  }

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function render(){
    potAmountEl.textContent = state.pot.toLocaleString();
    buyinTag.textContent = '바이인 ' + state.buyIn.toLocaleString();

    if(state.players.length === 0){
      playerList.innerHTML = `<div class="empty-state">아직 플레이어가 없어요.<br>아래에서 이름을 입력해 추가하세요.</div>`;
      return;
    }

    playerList.innerHTML = state.players.map(p => {
      const delta = p.stack - state.buyIn;
      const deltaClass = delta > 0 ? 'pos' : (delta < 0 ? 'neg' : '');
      const deltaText = delta === 0 ? '바이인과 동일' : (delta > 0 ? `+${delta.toLocaleString()}` : `${delta.toLocaleString()}`);
      return `
      <div class="player-card ${p.stack < 0 ? 'negative' : ''}" data-id="${p.id}">
        <div class="player-top">
          <div class="player-id">
            <div class="chip-stack">${chipSVG(colorForStack(p.stack, state.buyIn))}</div>
            <input class="player-name-input" data-action="rename" value="${escapeHtml(p.name)}" />
          </div>
          <button class="remove-btn" data-action="remove" title="삭제">✕</button>
        </div>
        <div class="player-stack-row">
          <div>
            <div class="stack-amount display ${p.stack < 0 ? 'neg' : ''}">${p.stack.toLocaleString()}</div>
            <div class="stack-delta ${deltaClass}">${deltaText}</div>
          </div>
        </div>
        <div class="adjust-row">
          <button class="chip-btn minus" data-action="adj" data-amt="-100">-100</button>
          <button class="chip-btn minus" data-action="adj" data-amt="-500">-500</button>
          <button class="chip-btn plus" data-action="adj" data-amt="500">+500</button>
          <button class="chip-btn plus" data-action="adj" data-amt="100">+100</button>
        </div>
        <div class="custom-row">
          <input type="number" data-role="customAmt" placeholder="직접 입력" inputmode="numeric">
          <button class="btn btn-ghost" data-action="custom-minus">빼기</button>
          <button class="btn btn-gold" data-action="custom-plus">더하기</button>
        </div>
      </div>`;
    }).join('');
  }

  // ===== WebSocket =====
  function wsUrl(){
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  function connect(code){
    roomCode = code.toUpperCase();
    $('roomCodeDisplay').textContent = roomCode;

    if(ws){ ws.onclose = null; ws.close(); }

    syncDot.style.background = 'var(--gold)';
    syncText.textContent = '연결 중...';

    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'join', room: roomCode }));
      syncDot.style.background = 'var(--success)';
      syncText.textContent = '실시간 동기화 중';
    };

    ws.onmessage = (event) => {
      let msg;
      try{ msg = JSON.parse(event.data); }catch(e){ return; }
      if(msg.type === 'state'){
        state = msg.state || { buyIn: 0, pot: 0, players: [] };
        render();
      }
    };

    ws.onclose = () => {
      syncDot.style.background = 'var(--danger)';
      syncText.textContent = '연결 끊김 — 재연결 중';
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect(roomCode), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
    };

    ws.onerror = () => {
      syncDot.style.background = 'var(--danger)';
      syncText.textContent = '동기화 실패 — 인터넷 연결 확인 필요';
    };
  }

  function pushState(){
    if(ws && ws.readyState === WebSocket.OPEN){
      ws.send(JSON.stringify({ type: 'update', state }));
    } else {
      showToast('동기화 실패 — 연결을 확인해주세요');
    }
  }

  // ===== Actions =====
  function addPlayer(name){
    if(!name.trim()) return;
    state.players.push({ id: uid(), name: name.trim(), stack: state.buyIn });
    render();
    pushState();
  }
  function removePlayer(id){
    state.players = state.players.filter(p => p.id !== id);
    render();
    pushState();
  }
  function renamePlayer(id, name){
    const p = state.players.find(p => p.id === id);
    if(p) p.name = name;
    pushState();
  }
  function adjustStack(id, amount){
    const p = state.players.find(p => p.id === id);
    if(!p) return;
    p.stack += amount;
    render();
    pushState();
  }
  function addToPot(amount){
    if(!amount || amount <= 0) return;
    state.pot += amount;
    render();
    pushState();
  }
  function clearPot(){
    state.pot = 0;
    render();
    pushState();
  }
  function setBuyIn(amount, applyToAll){
    state.buyIn = amount;
    if(applyToAll){ state.players.forEach(p => p.stack = amount); }
    render();
    pushState();
  }

  // ===== Settlement =====
  function calcSettlement(){
    const balances = state.players.map(p => ({ name: p.name, diff: p.stack - state.buyIn }));
    const creditors = balances.filter(b => b.diff > 0).map(b => ({...b})).sort((a,b)=> b.diff - a.diff);
    const debtors = balances.filter(b => b.diff < 0).map(b => ({...b, diff: -b.diff})).sort((a,b)=> b.diff - a.diff);
    const transactions = [];
    let i = 0, j = 0;
    while(i < debtors.length && j < creditors.length){
      const pay = Math.min(debtors[i].diff, creditors[j].diff);
      if(pay > 0) transactions.push({ from: debtors[i].name, to: creditors[j].name, amount: pay });
      debtors[i].diff -= pay;
      creditors[j].diff -= pay;
      if(debtors[i].diff === 0) i++;
      if(creditors[j].diff === 0) j++;
    }
    return { balances, transactions };
  }

  function openSettleModal(){
    const { balances, transactions } = calcSettlement();
    const totalPot = state.pot;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>정산 결과</h2>
        <div class="sub">바이인 ${state.buyIn.toLocaleString()} 기준 · 최소 거래 횟수로 계산했어요</div>
        ${balances.map(b => `
          <div class="check-row">
            <span>${escapeHtml(b.name)}</span>
            <span style="color:${b.diff > 0 ? 'var(--success)' : (b.diff < 0 ? 'var(--chip-red)' : 'var(--ink-dim)')}">${b.diff > 0 ? '+' : ''}${b.diff.toLocaleString()}</span>
          </div>
        `).join('')}
        ${totalPot > 0 ? `<div class="check-row"><span>미정산 팟</span><span>${totalPot.toLocaleString()}</span></div>` : ''}
        <div style="margin-top:18px;">
          ${transactions.length === 0
            ? `<div class="no-settle">주고받을 금액이 없어요. 정확히 맞아요! 🎉</div>`
            : transactions.map(t => `
              <div class="settle-row">
                <span>${escapeHtml(t.from)}</span>
                <span class="settle-arrow">→</span>
                <span class="settle-amount">${t.amount.toLocaleString()}</span>
                <span class="settle-arrow">→</span>
                <span>${escapeHtml(t.to)}</span>
              </div>`).join('')
          }
        </div>
        <button class="btn btn-gold modal-close" id="closeModalBtn">닫기</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });
    $('closeModalBtn').onclick = () => overlay.remove();
  }

  function openSetupModal(){
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>바이인 설정</h2>
        <div class="sub">모든 플레이어는 동일한 금액으로 시작해요</div>
        <div class="pot-controls" style="margin-bottom:6px;">
          <input type="number" id="buyinInput" placeholder="예: 10000" value="${state.buyIn || ''}" inputmode="numeric" style="flex:1; width:auto;">
        </div>
        <div class="sub" style="margin-top:6px;">기존 플레이어가 있다면 칩도 이 금액으로 다시 맞출까요?</div>
        <div style="display:flex; gap:8px; margin-top:10px;">
          <button class="btn btn-gold" id="applyAllBtn" style="flex:1;">전원 칩 리셋</button>
          <button class="btn btn-ghost" id="justSetBtn" style="flex:1;">기준값만 변경</button>
        </div>
        <button class="btn btn-ghost modal-close" id="closeSetupBtn">취소</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });
    $('closeSetupBtn').onclick = () => overlay.remove();
    $('applyAllBtn').onclick = () => {
      const val = parseInt($('buyinInput').value, 10);
      if(isNaN(val) || val < 0){ showToast('올바른 금액을 입력해주세요'); return; }
      setBuyIn(val, true);
      overlay.remove();
      showToast('바이인이 설정되고 전원 칩이 리셋됐어요');
    };
    $('justSetBtn').onclick = () => {
      const val = parseInt($('buyinInput').value, 10);
      if(isNaN(val) || val < 0){ showToast('올바른 금액을 입력해주세요'); return; }
      setBuyIn(val, false);
      overlay.remove();
      showToast('바이인 기준값이 변경됐어요');
    };
  }

  // ===== Event delegation =====
  playerList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if(!btn) return;
    const card = e.target.closest('.player-card');
    const id = card.dataset.id;
    const action = btn.dataset.action;

    if(action === 'remove'){
      removePlayer(id);
    } else if(action === 'adj'){
      adjustStack(id, parseInt(btn.dataset.amt, 10));
    } else if(action === 'custom-plus' || action === 'custom-minus'){
      const input = card.querySelector('[data-role="customAmt"]');
      const val = parseInt(input.value, 10);
      if(isNaN(val) || val <= 0){ showToast('금액을 입력해주세요'); return; }
      adjustStack(id, action === 'custom-plus' ? val : -val);
      input.value = '';
    }
  });

  playerList.addEventListener('change', (e) => {
    if(e.target.dataset.action === 'rename'){
      const card = e.target.closest('.player-card');
      renamePlayer(card.dataset.id, e.target.value);
    }
  });

  $('addPlayerBtn').onclick = () => {
    const input = $('newPlayerName');
    addPlayer(input.value);
    input.value = '';
  };
  $('newPlayerName').addEventListener('keydown', (e) => { if(e.key === 'Enter') $('addPlayerBtn').click(); });

  $('potAddBtn').onclick = () => {
    const input = $('potInput');
    const val = parseInt(input.value, 10);
    if(isNaN(val) || val <= 0){ showToast('금액을 입력해주세요'); return; }
    addToPot(val);
    input.value = '';
  };
  $('potClearBtn').onclick = () => {
    if(state.pot === 0) return;
    clearPot();
    showToast('팟을 비웠어요');
  };

  $('settleBtn').onclick = () => {
    if(state.players.length === 0){ showToast('플레이어를 먼저 추가해주세요'); return; }
    openSettleModal();
  };
  $('setupBtn').onclick = openSetupModal;

  $('copyLinkBtn').onclick = () => {
    const url = `${location.origin}${location.pathname}?room=${roomCode}`;
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(url).then(() => showToast('링크를 복사했어요'));
    } else {
      showToast(url);
    }
  };

  // ===== Join screen =====
  function randomRoomCode(){
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for(let i=0;i<4;i++) code += chars[Math.floor(Math.random()*chars.length)];
    return code;
  }

  function enterApp(code){
    $('joinScreen').style.display = 'none';
    $('app').style.display = 'block';
    connect(code);
  }

  $('joinBtn').onclick = () => {
    const val = $('roomCodeInput').value.trim();
    if(!val){ showToast('방 코드를 입력해주세요'); return; }
    enterApp(val);
  };
  $('roomCodeInput').addEventListener('keydown', (e) => { if(e.key === 'Enter') $('joinBtn').click(); });
  $('createBtn').onclick = () => enterApp(randomRoomCode());

  // Auto-join if ?room= is in URL
  (function autoJoin(){
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if(room){
      enterApp(room);
    }
  })();
})();
