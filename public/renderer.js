let agents = [];
let terminalLogCount = 0;

function formatTimestamp(date) {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} ${ampm}`;
}

function renderAgentCard(agent) {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.dataset.agentId = agent.id;

    const statusClass = agent.status.toLowerCase();
    const outputText = agent.output && agent.output.length > 0 
        ? agent.output.join('\n')
        : 'No recent output';

    card.innerHTML = `
        <div class="agent-header">
            <div class="agent-emoji">${agent.emoji}</div>
            <div class="agent-info">
                <div class="agent-name">${agent.name}</div>
                <div class="agent-role">${agent.role}</div>
            </div>
            <span class="status-badge ${statusClass}">${agent.status}</span>
        </div>
        <div class="agent-output" title="Click to expand/collapse">${outputText}</div>
    `;

    return card;
}

function renderAgentsList() {
    const agentsList = document.getElementById('agents-list');
    const agentCount = document.getElementById('agent-count');
    
    agentsList.innerHTML = '';
    agents.forEach(agent => {
        agentsList.appendChild(renderAgentCard(agent));
    });
    
    agentCount.textContent = agents.length;
}

function updateAgentSelector() {
    const selector = document.getElementById('agent-selector');
    const currentValue = selector.value;
    
    selector.innerHTML = '<option value="">Select agent...</option>';
    agents.forEach(agent => {
        const option = document.createElement('option');
        option.value = agent.id;
        option.textContent = `${agent.emoji} ${agent.name}`;
        selector.appendChild(option);
    });
    
    if (currentValue && agents.find(a => a.id === currentValue)) {
        selector.value = currentValue;
    } else if (agents.length > 0) {
        selector.value = agents[0].id;
    }
}

function updateAgentCard(agentId, status, output) {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;

    agent.status = status;
    if (output && output.length > 0) {
        agent.output = output;
    }

    const card = document.querySelector(`.agent-card[data-agent-id="${agentId}"]`);
    if (card) {
        const statusBadge = card.querySelector('.status-badge');
        statusBadge.className = `status-badge ${status.toLowerCase()}`;
        statusBadge.textContent = status;

        const outputText = output && output.length > 0 
            ? output.join('\n')
            : 'No recent output';
        const agentOutput = card.querySelector('.agent-output');
        agentOutput.textContent = outputText;
    }
}

function addTerminalEntry(logData) {
    const terminal = document.getElementById('terminal-content');
    const logCount = document.getElementById('log-count');
    
    const entry = document.createElement('div');
    entry.className = 'terminal-entry';
    
    const timestamp = document.createElement('span');
    timestamp.className = 'terminal-timestamp';
    timestamp.textContent = formatTimestamp(new Date(logData.timestamp));
    
    const message = document.createElement('span');
    message.className = `terminal-message ${logData.type || ''}`;
    
    const prefix = logData.emoji ? `${logData.emoji} ` : '';
    message.textContent = `${prefix}${logData.message}`;
    
    entry.appendChild(timestamp);
    entry.appendChild(message);
    terminal.appendChild(entry);
    
    terminalLogCount++;
    logCount.textContent = `${terminalLogCount} lines`;
    
    terminal.scrollTop = terminal.scrollHeight;
}

function renderQueueItem(queueItem, agentName, agentEmoji) {
    const card = document.createElement('div');
    card.className = 'queue-card';
    card.dataset.itemId = queueItem.id;

    const statusClass = queueItem.status.toLowerCase();
    const timestamp = formatTimestamp(new Date(queueItem.timestamp));
    const resultPreview = queueItem.result || '';

    card.innerHTML = `
        <div class="queue-header">
            <span class="queue-status ${statusClass}">${queueItem.status}</span>
            <span class="queue-timestamp">${timestamp}</span>
        </div>
        <div class="queue-command">${queueItem.command}</div>
        <div class="queue-agent">→ ${agentEmoji} ${agentName}</div>
        ${resultPreview ? `<div class="queue-result">${resultPreview}</div>` : ''}
    `;

    return card;
}

function updateQueue(agentId, queueItem) {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;

    if (!agent.queue) {
        agent.queue = [];
    }

    const existingIndex = agent.queue.findIndex(item => item.id === queueItem.id);
    if (existingIndex >= 0) {
        agent.queue[existingIndex] = queueItem;
    } else {
        agent.queue.push(queueItem);
    }

    renderAllQueues();
}

function renderAllQueues() {
    const queueList = document.getElementById('queue-list');
    const queueCount = document.getElementById('queue-count');
    
    queueList.innerHTML = '';
    
    let totalItems = 0;
    agents.forEach(agent => {
        if (agent.queue && agent.queue.length > 0) {
            agent.queue.forEach(item => {
                queueList.appendChild(renderQueueItem(item, agent.name, agent.emoji));
                totalItems++;
            });
        }
    });
    
    queueCount.textContent = totalItems;
}

function renderRosterList() {
    const rosterList = document.getElementById('roster-list');
    rosterList.innerHTML = '';
    
    if (agents.length === 0) {
        rosterList.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px;">No agents yet</div>';
        return;
    }
    
    agents.forEach(agent => {
        const item = document.createElement('div');
        item.className = 'roster-item';
        item.innerHTML = `
            <div class="roster-item-info">
                <div class="roster-item-emoji">${agent.emoji}</div>
                <div class="roster-item-details">
                    <div class="roster-item-name">${agent.name}</div>
                    <div class="roster-item-role">${agent.role}</div>
                </div>
            </div>
            <button class="btn-remove" data-agent-id="${agent.id}">Remove</button>
        `;
        rosterList.appendChild(item);
    });
    
    document.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const agentId = e.target.dataset.agentId;
            const agent = agents.find(a => a.id === agentId);
            if (agent && confirm(`Remove agent "${agent.name}"?`)) {
                try {
                    agents = await window.squadAPI.removeAgent(agentId);
                    renderAgentsList();
                    updateAgentSelector();
                    renderRosterList();
                    renderAllQueues();
                    addTerminalEntry({
                        timestamp: Date.now(),
                        message: `Agent ${agent.name} removed from roster`,
                        type: 'action'
                    });
                } catch (error) {
                    console.error('Failed to remove agent:', error);
                    alert('Failed to remove agent: ' + error.message);
                }
            }
        });
    });
}

async function initialize() {
    try {
        const [fetchedAgents, emojisResult] = await Promise.all([
            window.squadAPI.getAgents(),
            window.squadAPI.getEmojis().catch(() => [{ emoji: '🤖', label: 'Robot' }]),
        ]);
        agents = fetchedAgents;

        const emojiSelect = document.getElementById('agent-emoji');
        const emojiList = emojisResult.length > 0 ? emojisResult : [{ emoji: '🤖', label: 'Robot' }];
        emojiList.forEach(({ emoji, label }) => {
            const option = document.createElement('option');
            option.value = emoji;
            option.textContent = `${emoji} ${label}`;
            emojiSelect.appendChild(option);
        });
        renderAgentsList();
        updateAgentSelector();
        renderAllQueues();
        
        for (const agent of agents) {
            const queue = await window.squadAPI.getQueue(agent.id);
            agent.queue = queue;
        }
        renderAllQueues();
        
    } catch (error) {
        console.error('Failed to initialize:', error);
        addTerminalEntry({
            timestamp: Date.now(),
            message: `Initialization error: ${error.message}`,
            type: 'error'
        });
    }

    window.squadAPI.onAgentStatusUpdate((agentId, status, output) => {
        updateAgentCard(agentId, status, output);
    });

    window.squadAPI.onTerminalLog((logData) => {
        addTerminalEntry(logData);
    });

    window.squadAPI.onQueueUpdate((agentId, queueItem) => {
        updateQueue(agentId, queueItem);
    });

    // Poll connection status
    updateConnectionStatus();
    setInterval(updateConnectionStatus, 5000);

    // Click-to-expand agent output (event delegation — survives re-renders)
    document.getElementById('agents-list').addEventListener('click', function(e) {
        const output = e.target.closest('.agent-output');
        if (output) output.classList.toggle('expanded');
    });
}

async function updateConnectionStatus() {
    const badge = document.getElementById('connection-status');
    if (!badge) return;
    try {
        const status = await window.squadAPI.getConnectionStatus();
        badge.className = `connection-badge ${status}`;
        const labels = {
            connected: '●  Connected',
            connecting: '●  Connecting...',
            reconnecting: '●  Reconnecting...',
            disconnected: '●  Disconnected',
            error: '●  Error'
        };
        badge.textContent = labels[status] || `●  ${status}`;
    } catch (_) {
        badge.className = 'connection-badge disconnected';
        badge.textContent = '●  Disconnected';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initialize();

    const commandInput = document.getElementById('command-input');
    const agentSelector = document.getElementById('agent-selector');
    
    commandInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault();
            
            const command = commandInput.value.trim();
            const agentId = agentSelector.value;
            
            if (!command) return;
            if (!agentId) {
                alert('Please select an agent first');
                return;
            }
            
            try {
                const queueItem = await window.squadAPI.sendCommand(agentId, command);
                commandInput.value = '';
                commandInput.style.height = 'auto';
                // In native mode there's no server push, so update UI directly
                const agent = agents.find(a => a.id === agentId);
                if (agent && queueItem && !queueItem.error) {
                    updateQueue(agentId, queueItem);
                    addTerminalEntry({
                        timestamp: Date.now(),
                        agentName: agent.name,
                        emoji: agent.emoji,
                        message: `Command queued: ${command}`,
                        type: 'action'
                    });
                }
            } catch (error) {
                console.error('Failed to send command:', error);
                addTerminalEntry({
                    timestamp: Date.now(),
                    message: `Failed to send command: ${error.message}`,
                    type: 'error'
                });
            }
        } else if (e.key === 'Enter' && e.ctrlKey) {
            const start = commandInput.selectionStart;
            const end = commandInput.selectionEnd;
            const value = commandInput.value;
            commandInput.value = value.substring(0, start) + '\n' + value.substring(end);
            commandInput.selectionStart = commandInput.selectionEnd = start + 1;
            e.preventDefault();
        }
    });

    commandInput.addEventListener('input', () => {
        commandInput.style.height = 'auto';
        commandInput.style.height = Math.min(commandInput.scrollHeight, 120) + 'px';
    });

    const rosterBtn = document.getElementById('roster-btn');
    const rosterModal = document.getElementById('roster-modal');
    const modalClose = document.querySelector('.modal-close');
    
    rosterBtn.addEventListener('click', () => {
        rosterModal.classList.add('active');
        renderRosterList();
    });
    
    modalClose.addEventListener('click', () => {
        rosterModal.classList.remove('active');
    });
    
    rosterModal.addEventListener('click', (e) => {
        if (e.target === rosterModal) {
            rosterModal.classList.remove('active');
        }
    });

    const addAgentForm = document.getElementById('add-agent-form');

    // Connection badge click → reconnect
    const connBadge = document.getElementById('connection-status');
    if (connBadge) {
        connBadge.addEventListener('click', async () => {
            connBadge.className = 'connection-badge connecting';
            connBadge.textContent = '●  Connecting...';
            try {
                await window.squadAPI.reconnectCopilot();
                updateConnectionStatus();
            } catch (_) { /* status poll will catch it */ }
        });
    }

    addAgentForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const name = document.getElementById('agent-name').value.trim();
        const role = document.getElementById('agent-role').value.trim();
        const emoji = document.getElementById('agent-emoji').value.trim();
        
        if (!name || !role || !emoji) {
            alert('All fields are required');
            return;
        }
        
        try {
            agents = await window.squadAPI.addAgent(name, role, emoji);
            renderAgentsList();
            updateAgentSelector();
            renderRosterList();
            
            addAgentForm.reset();
            
            addTerminalEntry({
                timestamp: Date.now(),
                emoji: emoji,
                message: `Agent ${name} added to roster`,
                type: 'success'
            });
        } catch (error) {
            console.error('Failed to add agent:', error);
            alert('Failed to add agent: ' + error.message);
        }
    });
});
