/* Modal and agent-edit reliability fixes. */
window.dismissModal = () => modal.classList.remove('show');
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button && (button.textContent.trim() === 'Cancel' || button.textContent.trim() === '×')) {
    event.preventDefault();
    dismissModal();
  }
});
function editAgent(id) {
  const a = state.agents.find(x => x.id === id);
  open(`<div class="dhead"><h2>Edit agent</h2><button type="button" onclick="dismissModal()">×</button></div><form class="form" onsubmit="saveAgentEdit(event,'${id}')"><div><label>FULL NAME</label><input name="name" value="${e(a.name)}" required></div><div><label>EMPLOYEE ID</label><input name="employeeId" value="${e(a.employeeId)}" required></div><div><label>PHONE</label><input name="phone" value="${e(a.phone||'')}"></div><div><label>STATUS</label><select name="status"><option ${a.status==='active'?'selected':''}>active</option><option ${a.status==='suspended'?'selected':''}>suspended</option></select></div><div class="wide actions"><button type="button" class="secondary" onclick="dismissModal()">Cancel</button><button class="primary">Save changes</button></div></form>`);
}
async function saveAgentEdit(event,id) {
  event.preventDefault();
  try { await api('/api/agents/'+id,{method:'PUT',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))}); dismissModal(); await load(); go('agents'); }
  catch (error) { alert(error.message); }
}
const renderAgentsWithEdit = agents;
agents = function () {
  renderAgentsWithEdit();
  document.querySelectorAll('tbody tr').forEach(row => {
    const name = row.querySelector('td b')?.textContent;
    const agent = state.agents.find(a => a.name === name);
    if (agent && write()) row.lastElementChild.insertAdjacentHTML('afterbegin', `<button class="secondary" onclick="editAgent('${agent.id}')">Edit</button> `);
  });
};
