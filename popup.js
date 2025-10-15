// Popup script
document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('modelSelect');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');
  const autoAnswerToggle = document.getElementById('autoAnswerToggle');
  const clearMemoryBtn = document.getElementById('clearMemoryBtn');
  const memoryStats = document.getElementById('memoryStats');
  const viewCacheBtn = document.getElementById('viewCacheBtn');
  const exportCacheBtn = document.getElementById('exportCacheBtn');
  const importCacheBtn = document.getElementById('importCacheBtn');
  const importFileInput = document.getElementById('importFileInput');
  const cacheModal = document.getElementById('cacheModal');
  const closeCacheModal = document.getElementById('closeCacheModal');
  const cacheList = document.getElementById('cacheList');
  const cacheSearch = document.getElementById('cacheSearch');

  let currentCache = {};

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function selectItemByKey(key) {
    try {
      return cacheList.querySelector(`[data-key="${CSS.escape(key)}"]`);
    } catch (err) {
      const items = cacheList.querySelectorAll('[data-key]');
      return Array.from(items).find(el => el.dataset.key === key) || null;
    }
  }

  // Load and display memory stats
  function updateMemoryStats() {
    chrome.storage.local.get(['questionMemory', 'cacheHits'], (result) => {
      currentCache = result.questionMemory || {};
      const count = Object.keys(currentCache).length;
      const hits = result.cacheHits || 0;

      document.getElementById('cacheCount').textContent = count;
      document.getElementById('cacheSaved').textContent = hits;
    });
  }

  updateMemoryStats();

  // Load saved settings
  chrome.storage.sync.get(['groqApiKey', 'selectedModel', 'autoAnswerEnabled'], (result) => {
    if (result.groqApiKey) {
      apiKeyInput.value = result.groqApiKey;
    }
    if (result.selectedModel) {
      modelSelect.value = result.selectedModel;
    }
    autoAnswerToggle.checked = result.autoAnswerEnabled || false;
  });

  // Save settings
  saveBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    const model = modelSelect.value;

    if (!apiKey) {
      showStatus('Please enter an API key', 'error');
      return;
    }

    if (!apiKey.startsWith('gsk_')) {
      showStatus('Invalid API key format. Should start with gsk_', 'error');
      return;
    }

    chrome.storage.sync.set({
      groqApiKey: apiKey,
      selectedModel: model
    }, () => {
      showStatus('Settings saved successfully!', 'success');
    });
  });

  // Toggle auto-answer
  autoAnswerToggle.addEventListener('change', async () => {
    const enabled = autoAnswerToggle.checked;

    // Check if API key is set
    const result = await chrome.storage.sync.get(['groqApiKey']);
    if (enabled && !result.groqApiKey) {
      showStatus('Please configure Groq API key first', 'error');
      autoAnswerToggle.checked = false;
      return;
    }

    chrome.storage.sync.set({ autoAnswerEnabled: enabled }, () => {
      // Send message to content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'toggleAutoAnswer',
            enabled: enabled
          }).catch(err => {
            console.log('Could not send message to content script:', err);
          });
        }
      });

      showStatus(enabled ? 'Auto-answer enabled!' : 'Auto-answer disabled', 'success');
    });
  });

  // Render cache list
  function renderCacheList(searchTerm = '') {
    cacheList.innerHTML = '';

    const entries = Object.entries(currentCache);

    if (entries.length === 0) {
      cacheList.innerHTML = `
        <div class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>
          <p>No cached questions yet<br>Play some games to build the cache!</p>
        </div>
      `;
      return;
    }

    // Filter by search term
    const filtered = entries.filter(([key, data]) => {
      if (!searchTerm) return true;
      const search = searchTerm.toLowerCase();
      const questionText = (data.questionText || key).toLowerCase();
      const answerText = (data.answer || '').toLowerCase();
      return questionText.includes(search) || answerText.includes(search);
    });

    if (filtered.length === 0) {
      cacheList.innerHTML = `
        <div class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <p>No results found</p>
        </div>
      `;
      return;
    }

    // Sort by most recently used
    filtered.sort((a, b) => (b[1].lastUsed || 0) - (a[1].lastUsed || 0));

    filtered.forEach(([key, data]) => {
      const item = document.createElement('div');
      item.className = 'cache-item';
      item.dataset.key = key;

      const questionText = data.questionText || key.replace(/\|\|\|img:[a-f0-9]+/i, '');
      const displayQuestion = escapeHtml(questionText);
      const answerText = escapeHtml(data.answer || '');
      const lastUsed = data.lastUsed ? new Date(data.lastUsed).toLocaleString('cs-CZ') : 'Never';
      const timesUsed = data.stats?.timesUsed ?? data.usedCount ?? 1;
      const imageSource = data.image?.dataUrl || data.image?.url || null;
      const imageHash = data.image?.hash ? ` • IMG ${escapeHtml(data.image.hash.slice(0, 8))}` : '';

      const headerHtml = `
        <div class="cache-header">
          <div class="cache-question">${displayQuestion}</div>
          ${imageSource ? `<div class="cache-image"><img src="${escapeAttr(imageSource)}" alt="Question image"></div>` : ''}
        </div>
      `;

      const bodyHtml = `
        <div class="cache-answer">${answerText}</div>
        <div class="cache-meta">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Used ${timesUsed}x • Last: ${lastUsed}${imageHash}
        </div>
        <div class="cache-actions">
          <button class="cache-btn cache-btn-edit" data-key="${escapeAttr(key)}">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            Edit
          </button>
          <button class="cache-btn cache-btn-delete" data-key="${escapeAttr(key)}">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Delete
          </button>
        </div>
      `;

      item.innerHTML = headerHtml + bodyHtml;

      cacheList.appendChild(item);
    });

    // Add event listeners
    cacheList.querySelectorAll('.cache-btn-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = e.target.closest('button').dataset.key;
        editCacheItem(key);
      });
    });

    cacheList.querySelectorAll('.cache-btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = e.target.closest('button').dataset.key;
        deleteCacheItem(key);
      });
    });
  }

  // Edit cache item
  function editCacheItem(key) {
    const item = selectItemByKey(key);
    if (!item) return;

    const data = currentCache[key];
    const question = data.questionText || key.replace(/\|\|\|img:[a-f0-9]+/i, '');
    const imageSource = data.image?.dataUrl || data.image?.url || null;

    item.innerHTML = `
      <div class="cache-header">
        <div class="cache-question">${escapeHtml(question)}</div>
        ${imageSource ? `<div class="cache-image"><img src="${escapeAttr(imageSource)}" alt="Question image"></div>` : ''}
      </div>
      <input type="text" class="cache-edit-input" id="editAnswer" value="${escapeAttr(data.answer || '')}" placeholder="Answer">
      <div class="cache-actions">
        <button class="cache-btn cache-btn-save">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Save
        </button>
        <button class="cache-btn cache-btn-cancel">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Cancel
        </button>
      </div>
    `;

    const saveBtn = item.querySelector('.cache-btn-save');
    const cancelBtn = item.querySelector('.cache-btn-cancel');
    const input = item.querySelector('#editAnswer');

    saveBtn.addEventListener('click', () => {
      const newAnswer = input.value.trim();
      if (!newAnswer) {
        alert('Answer cannot be empty!');
        return;
      }

      currentCache[key].answer = newAnswer;
      currentCache[key].lastUsed = Date.now();

      chrome.storage.local.set({ questionMemory: currentCache }, () => {
        showStatus('Answer updated!', 'success');
        renderCacheList(cacheSearch.value);
      });
    });

    cancelBtn.addEventListener('click', () => {
      renderCacheList(cacheSearch.value);
    });

    input.focus();
  }

  // Delete cache item
  function deleteCacheItem(key) {
    if (!confirm('Delete this cached answer?')) return;

    delete currentCache[key];

    chrome.storage.local.set({ questionMemory: currentCache }, () => {
      showStatus('Deleted successfully!', 'success');
      updateMemoryStats();
      renderCacheList(cacheSearch.value);
    });
  }

  // View cache button
  viewCacheBtn.addEventListener('click', () => {
    chrome.storage.local.get(['questionMemory'], (result) => {
      currentCache = result.questionMemory || {};
      renderCacheList();
      cacheModal.classList.add('active');
    });
  });

  // Close modal
  closeCacheModal.addEventListener('click', () => {
    cacheModal.classList.remove('active');
    cacheSearch.value = '';
  });

  // Close modal on overlay click
  cacheModal.addEventListener('click', (e) => {
    if (e.target === cacheModal) {
      cacheModal.classList.remove('active');
      cacheSearch.value = '';
    }
  });

  // Search cache
  cacheSearch.addEventListener('input', (e) => {
    renderCacheList(e.target.value);
  });

  // Export cache
  exportCacheBtn.addEventListener('click', () => {
    chrome.storage.local.get(['questionMemory'], (result) => {
      const cache = result.questionMemory || {};
      const json = JSON.stringify(cache, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vyzyvatel-cache-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showStatus('Cache exported!', 'success');
    });
  });

  // Import cache button
  importCacheBtn.addEventListener('click', () => {
    importFileInput.click();
  });

  // Import file handler
  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target.result);

        if (confirm(`Import ${Object.keys(imported).length} cached answers? This will merge with existing cache.`)) {
          chrome.storage.local.get(['questionMemory'], (result) => {
            const existing = result.questionMemory || {};
            const merged = { ...existing, ...imported };

            chrome.storage.local.set({ questionMemory: merged }, () => {
              showStatus('Cache imported successfully!', 'success');
              updateMemoryStats();

              // Also notify content script to reload cache
              chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                  chrome.tabs.sendMessage(tabs[0].id, {
                    action: 'reloadMemory'
                  }).catch(err => {
                    console.log('Could not send message to content script:', err);
                  });
                }
              });
            });
          });
        }
      } catch (err) {
        showStatus('Invalid JSON file!', 'error');
        console.error(err);
      }
    };
    reader.readAsText(file);

    // Reset input
    e.target.value = '';
  });

  // Clear memory button
  clearMemoryBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear the answer cache? This will increase API usage until cache rebuilds.')) {
      chrome.storage.local.set({ questionMemory: {} }, () => {
        showStatus('Cache cleared successfully!', 'success');
        updateMemoryStats();

        // Also notify content script to clear its in-memory cache
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'clearMemory'
            }).catch(err => {
              console.log('Could not send message to content script:', err);
            });
          }
        });
      });
    }
  });

  function showStatus(message, type) {
    const icon = type === 'success'
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

    statusDiv.innerHTML = icon + message;
    statusDiv.className = `status ${type}`;
    statusDiv.style.display = 'flex';

    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 3000);
  }
});
