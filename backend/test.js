
/* Modern balance modal style (updated colors + buttons) */
.balance-modal {
  font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
  max-width: 520px;
  padding: 18px;
  border-radius: 12px;
  background: linear-gradient(180deg, #ffffff, #fbfdff);
  box-shadow: 0 12px 40px rgba(8,20,50,0.08);
  color: #0f1724;
  line-height: 1.3;
}
.balance-modal h3 { margin: 0 0 10px; font-size: 20px; }
.balance-user { display:flex; align-items:center; gap:12px; }
.balance-avatar {
  width:44px; height:44px; border-radius:10px; background: linear-gradient(135deg,#eef2ff,#e6f7ff);
  display:flex; align-items:center; justify-content:center; font-weight:700; color:#0b5cff;
}
.balance-row { margin-top:12px; display:flex; align-items:center; justify-content:space-between; }
.balance-col { flex:1; }
.counter { font-weight:700; font-size:20px; }
.counter-sub { font-size:12px; color:#475569; margin-top:6px; }

/* button group - improved primary blue */
.btn-row { margin-top:16px; display:flex; gap:8px; justify-content:flex-end; }
.btn {
  padding:8px 12px; border-radius:8px; border:0; cursor:pointer; font-weight:600;
  background: linear-gradient(180deg,#0b6cff,#0a58d6); color:white;
  box-shadow: 0 6px 18px rgba(10,86,214,0.14);
}
.btn-ghost {
  padding:8px 12px; border-radius:8px; border:1px solid #e6eefb; background:white; color:#0b5cff; cursor:pointer;
}
.small-muted { font-size:12px; color:#94a3b8; }

/* compact list for requests */
.requests-list { max-height:360px; overflow:auto; margin-top:10px; padding:6px; border-radius:8px; background:#fbfdff; border:1px solid #eef2ff; }
.request-item { padding:10px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; gap:10px; align-items:center; }
.request-left { display:flex; flex-direction:column; gap:4px; }
.request-status { padding:6px 8px; border-radius:10px; font-weight:700; font-size:12px; }
.status-pending { background:#fff7ed; color:#b45309; border:1px solid rgba(245,158,11,0.08); }
.status-verified { background:#ecfdf5; color:#059669; border:1px solid rgba(16,185,129,0.08); }
.status-rejected { background:#fff1f2; color:#be123c; border:1px solid rgba(239,68,68,0.08); }
.small-cta { font-size:13px; padding:6px 8px; border-radius:8px; cursor:pointer; background:#f1f5f9; border:0; }
.toggle-row { display:flex; gap:8px; align-items:center; margin-top:8px; }

/* countdown display */
.countdown { font-weight:700; color:#0b5cff; }

/* responsive */
@media (max-width:520px){
  .balance-modal { width:calc(100vw - 32px); }
  .counter { font-size:18px; }
  .btn-row { flex-direction:column; align-items:stretch; }
}

/* Unopened (new) title highlight + small badge */
.ann-unopened .ann-title { color: var(--danger); }
.ann-new-badge {
  display:inline-block;
  background:var(--danger);
  color:#fff;
  font-size:12px;
  padding:2px 8px;
  border-radius:999px;
  margin-left:8px;
  vertical-align:middle;
  font-weight:700;
  line-height:1;
}