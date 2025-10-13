// Content script for vyzyvatel.com

let isProcessing = false;
let autoAnswerEnabled = false;
let statusIndicator = null;
let lastQuestionText = ''; // Remember last question to avoid reprocessing
let questionMemory = {}; // In-memory cache of question -> answer mapping
let currentQuestion = null; // Track current question for result detection
let currentAnswer = null; // Track current answer for result detection
let currentCacheKey = null; // Track cache key (question + image URL if present)
let waitingForResult = false; // Flag to indicate we're waiting for answer result

// Extension ready on load
window.addEventListener('load', () => {
  // Ready
});

// Listen for enable/disable from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggleAutoAnswer') {
    autoAnswerEnabled = request.enabled;
    console.log('Auto-answer', autoAnswerEnabled ? 'enabled' : 'disabled');
    if (autoAnswerEnabled) {
      createStatusIndicator();
      checkForQuestion();
    } else {
      removeStatusIndicator();
    }
  } else if (request.action === 'clearMemory') {
    // Clear in-memory cache when user clears cache from popup
    questionMemory = {};
  } else if (request.action === 'reloadMemory') {
    // Reload memory after import
    chrome.storage.local.get(['questionMemory'], (result) => {
      questionMemory = result.questionMemory || {};
    });
  }
});

// Load memory from storage
chrome.storage.local.get(['questionMemory'], (result) => {
  questionMemory = result.questionMemory || {};
});

// Check if auto-answer is enabled on load
chrome.storage.sync.get(['autoAnswerEnabled'], (result) => {
  autoAnswerEnabled = result.autoAnswerEnabled || false;

  if (autoAnswerEnabled) {
    createStatusIndicator();
    checkForQuestion();
  }
});

// Result detection - watches DOM for correct/incorrect feedback
function detectAnswerResult() {

  // IMMEDIATE CHECK - maybe it's already there
  const immediateCheck = document.querySelector('div.bg-green-600');
  if (immediateCheck) {
    const correctAnswerFromUI = immediateCheck.textContent.trim();

    waitingForResult = false;

    if (currentQuestion) {
      const ourAnswer = normalizeAnswer(currentAnswer);
      const uiAnswer = normalizeAnswer(correctAnswerFromUI);

      if (ourAnswer === uiAnswer) {
        console.log('✅');
        saveToMemory(currentCacheKey, correctAnswerFromUI, true);
      } else {
        console.log('❌ → ' + correctAnswerFromUI);
        saveToMemory(currentCacheKey, correctAnswerFromUI, true);
      }

      currentQuestion = null;
      currentAnswer = null;
      currentCacheKey = null;
    }
    return; // Don't start observer
  }

  // Track answer buttons to detect CSS changes
  const trackedButtons = new Map();
  let scanCount = 0;

  const resultObserver = new MutationObserver((mutations) => {
    if (!waitingForResult) return;

    scanCount++;

    // Only log detailed scan every 20 mutations to reduce spam
    const shouldLogDetailed = scanCount === 1 || scanCount === 5 || scanCount % 20 === 0;

    const allButtons = document.querySelectorAll('button[data-slot="button"]');
    let foundSpecialButton = false;

    // Find answer buttons (buttons with meaningful text > 3 chars)
    const answerButtons = Array.from(allButtons).filter(btn => {
      const text = btn.textContent.trim();
      return text.length > 3 && !['Opustit hru', 'Připojit do hry'].includes(text);
    });

    // CSS tracking enabled

    answerButtons.forEach((btn, idx) => {
      const textElement = btn.querySelector('p.select-none, p.font-semibold, p');
      const buttonText = textElement ? textElement.textContent.trim() : btn.textContent.trim();

      // Extract relevant CSS classes
      const bgClasses = Array.from(btn.classList).filter(c =>
        c.includes('bg-') || c.includes('border-') || c.includes('ring-') ||
        c.includes('outline-') || c.includes('text-')
      ).join(' ');

      const computedStyle = window.getComputedStyle(btn);
      const bgColor = computedStyle.backgroundColor;
      const color = computedStyle.color;
      const border = computedStyle.border;

      // Create signature for change detection
      const signature = `${bgClasses}|${bgColor}|${color}|${border}`;
      const previousSignature = trackedButtons.get(buttonText);

      // Detect change
      if (previousSignature && previousSignature !== signature) {
        // CSS changed - button state updated
        foundSpecialButton = true;
      }

      // Store current signature
      trackedButtons.set(buttonText, signature);

      // Tracking button CSS state (detailed logs removed)
    });

    // CSS tracking active

    // Look for green box with correct answer: bg-green-600 (for numeric questions)
    const correctIndicator = document.querySelector('div.bg-green-600');

    // Look for red box with incorrect answer: bg-red-600 or similar
    const incorrectIndicator = document.querySelector('div.bg-red-600, div.bg-red-500');

    // Look for red button (wrong answer in multiple choice - bg-red-500)
    // This indicates we clicked a wrong answer and can find the correct one
    const redButton = Array.from(allButtons).find(btn => {
      return btn.classList.contains('bg-red-500');
    });

    // For multiple choice: If we see a red button, look for correct answer among OTHER buttons
    let orangeOutlineButton = null;
    if (redButton) {
      // Detected wrong answer

      // Strategy: Look for buttons with YELLOW/ORANGE 3px border (correct answer indicator)
      const correctButtons = Array.from(allButtons).filter(btn => {
        const isNotRed = !btn.classList.contains('bg-red-500');
        const isNotBlue = !btn.classList.contains('bg-blue-500');
        const hasText = btn.textContent.trim() !== '';
        const computed = window.getComputedStyle(btn);
        const isVisible = computed.display !== 'none' && computed.visibility !== 'hidden';

        // Check for 3px yellow/orange border: rgb(251, 191, 36)
        const border = computed.border;
        const hasYellowBorder = border.includes('3px') && border.includes('rgb(251, 191, 36)');

        return isNotRed && isNotBlue && hasText && isVisible && hasYellowBorder;
      });

      if (correctButtons.length > 0) {
        orangeOutlineButton = correctButtons[0];
        // Correct answer detected via yellow border
      }
    }

    // Result detection active

    if (correctIndicator) {
      // Remove the arrow div from text content
      const arrowDiv = correctIndicator.querySelector('div.absolute');
      if (arrowDiv) {
        arrowDiv.remove();
      }

      const correctAnswerFromUI = correctIndicator.textContent.trim();

      waitingForResult = false;

      if (currentQuestion && currentAnswer) {
        // Check if our answer matches the correct one
        const ourAnswer = normalizeAnswer(currentAnswer);
        const uiAnswer = normalizeAnswer(correctAnswerFromUI);

        if (ourAnswer === uiAnswer) {
          console.log('✅');
          saveToMemory(currentCacheKey, correctAnswerFromUI, true);
        } else {
          console.log('❌ → ' + correctAnswerFromUI);
          saveToMemory(currentCacheKey, correctAnswerFromUI, true);
        }

        currentQuestion = null;
        currentAnswer = null;
        currentCacheKey = null;
      }
      resultObserver.disconnect();
    } else if (orangeOutlineButton) {
      // Multiple choice correct answer found
      const textElement = orangeOutlineButton.querySelector('p.select-none, p.font-semibold, p');
      const correctAnswerFromUI = textElement ? textElement.textContent.trim() : orangeOutlineButton.textContent.trim();

      waitingForResult = false;

      if (currentQuestion) {
        if (currentAnswer) {
          // Check if our answer matches the correct one
          const ourAnswer = normalizeAnswer(currentAnswer);
          const uiAnswer = normalizeAnswer(correctAnswerFromUI);

          if (ourAnswer === uiAnswer) {
            console.log('✅');
            saveToMemory(currentCacheKey, correctAnswerFromUI, true);
          } else {
            console.log('❌ → ' + correctAnswerFromUI);
            saveToMemory(currentCacheKey, correctAnswerFromUI, true);
          }
        } else {
          // No current answer tracked, but found correct answer - save it
          saveToMemory(currentCacheKey, correctAnswerFromUI, true);
        }

        currentQuestion = null;
        currentAnswer = null;
        currentCacheKey = null;
      }
      resultObserver.disconnect();
    } else if (incorrectIndicator) {
      waitingForResult = false;
      currentQuestion = null;
      currentAnswer = null;
      currentCacheKey = null;
      resultObserver.disconnect();
    }
  });

  resultObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  // Timeout after 15 seconds - try multiple times to find correct answer
  const savedQuestion = currentQuestion;
  const savedAnswer = currentAnswer;
  const savedCacheKey = currentCacheKey;

  // Try checking at 3s, 6s, 9s, 12s, 15s
  const checkAttempts = [3000, 6000, 9000, 12000, 15000];
  let attemptCount = 0;

  const tryFindCorrectAnswer = () => {
    if (!waitingForResult || !savedQuestion) {
      return; // Already found
    }

    attemptCount++;

    // Check for green box (numeric questions)
    const finalCheck = document.querySelector('div.bg-green-600');
    if (finalCheck) {
      const arrowDiv = finalCheck.querySelector('div.absolute');
      if (arrowDiv) arrowDiv.remove();
      const correctAnswerFromUI = finalCheck.textContent.trim();
      saveToMemory(savedCacheKey, correctAnswerFromUI, true);
      waitingForResult = false;
      currentQuestion = null;
      currentAnswer = null;
      currentCacheKey = null;
      resultObserver.disconnect();
      return;
    }

    // Check for multiple choice result
    const allButtonsFinal = document.querySelectorAll('button[data-slot="button"]');

    // Try to find yellow border (correct answer indicator)
    const yellowBorderButtons = Array.from(allButtonsFinal).filter(btn => {
      const isNotRed = !btn.classList.contains('bg-red-500');
      const isNotBlue = !btn.classList.contains('bg-blue-500');
      const hasText = btn.textContent.trim() !== '';
      const computed = window.getComputedStyle(btn);
      const isVisible = computed.display !== 'none' && computed.visibility !== 'hidden';
      const border = computed.border;
      const hasYellowBorder = border.includes('3px') && border.includes('rgb(251, 191, 36)');
      return isNotRed && isNotBlue && hasText && isVisible && hasYellowBorder;
    });

    if (yellowBorderButtons.length > 0) {
      const textElement = yellowBorderButtons[0].querySelector('p.select-none, p.font-semibold, p');
      const correctAnswer = textElement ? textElement.textContent.trim() : yellowBorderButtons[0].textContent.trim();
      saveToMemory(savedCacheKey, correctAnswer, true);
      waitingForResult = false;
      currentQuestion = null;
      currentAnswer = null;
      currentCacheKey = null;
      resultObserver.disconnect();
      return;
    }

    // If this is the last attempt and we still haven't found it, give up
    if (attemptCount >= checkAttempts.length) {
      waitingForResult = false;
      currentQuestion = null;
      currentAnswer = null;
      currentCacheKey = null;
      resultObserver.disconnect();
    }
  };

  // Schedule checks at 3s, 6s, 9s, 12s, 15s
  checkAttempts.forEach(delay => {
    setTimeout(tryFindCorrectAnswer, delay);
  });
}

// Memory functions
function normalizeQuestion(question) {
  // Normalize question text for better matching (remove extra spaces, lowercase)
  return question.toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeAnswer(answer) {
  if (!answer) return '';

  let normalized = answer.toString().trim().toLowerCase();

  // Remove spaces, commas, dots that are used as thousands separators in numbers
  // But preserve decimal points (dots followed by 1-2 digits at the end)

  // First, protect decimal points by temporarily replacing them
  normalized = normalized.replace(/\.(\d{1,2})$/, '###DECIMAL###$1');

  // Remove all spaces, commas, and dots (thousands separators)
  normalized = normalized.replace(/[\s,.]/g, '');

  // Restore decimal points
  normalized = normalized.replace(/###DECIMAL###/g, '.');

  return normalized;
}

function saveToMemory(question, answer, wasCorrect = true) {
  const key = normalizeQuestion(question);
  const existing = questionMemory[key];

  if (!existing) {
    // New entry
    questionMemory[key] = {
      answer: answer,
      timestamp: Date.now(),
      lastUsed: Date.now(),
      stats: {
        timesUsed: 1,
        timesCorrect: wasCorrect ? 1 : 0,
        timesWrong: wasCorrect ? 0 : 1,
        healthScore: wasCorrect ? 1.0 : 0.0
      },
      confidence: {
        score: wasCorrect ? 0.8 : 0.5,
        source: 'ai',
        verified: wasCorrect
      }
    };
  } else {
    // Update existing entry
    existing.lastUsed = Date.now();
    existing.stats.timesUsed++;

    if (wasCorrect) {
      existing.stats.timesCorrect++;
      existing.confidence.score = Math.min(0.99, existing.confidence.score + 0.05);
      existing.confidence.verified = true;
    } else {
      existing.stats.timesWrong++;
      existing.confidence.score = Math.max(0.1, existing.confidence.score - 0.2);

      // If answer is different and we have low health, replace it
      if (existing.answer !== answer && existing.stats.healthScore < 0.5) {
        existing.answer = answer;
        existing.stats.timesCorrect = 1;
        existing.stats.timesWrong = 0;
        existing.confidence.score = 0.7;
      }
    }

    // Recalculate health score
    const total = existing.stats.timesCorrect + existing.stats.timesWrong;
    existing.stats.healthScore = total > 0 ? existing.stats.timesCorrect / total : 1.0;

    // Auto-cleanup bad entries
    if (existing.stats.healthScore < 0.3 && existing.stats.timesUsed > 3) {
      console.log(`🗑️ Removing bad cache entry: ${key} (health: ${existing.stats.healthScore})`);
      delete questionMemory[key];
    }
  }

  // Save to persistent storage
  chrome.storage.local.set({ questionMemory: questionMemory });
}

function getFromMemory(question) {
  const key = normalizeQuestion(question);
  const memory = questionMemory[key];

  if (memory) {
    // Increment cache hits counter
    chrome.storage.local.get(['cacheHits'], (result) => {
      const hits = (result.cacheHits || 0) + 1;
      chrome.storage.local.set({ cacheHits: hits });
    });

    // Return answer with metadata
    return {
      answer: memory.answer,
      confidence: memory.confidence?.score || 0.8,
      healthScore: memory.stats?.healthScore || 1.0,
      timesUsed: memory.stats?.timesUsed || 1
    };
  }

  return null;
}

// Create visual status indicator
function createStatusIndicator() {
  if (statusIndicator) return;

  statusIndicator = document.createElement('div');
  statusIndicator.id = 'vyzyvatel-status';
  statusIndicator.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 12px 20px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border-radius: 8px;
    font-weight: bold;
    font-size: 14px;
    z-index: 10000;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: all 0.3s ease;
  `;
  statusIndicator.innerHTML = '🤖 <span>Auto-Answer Ready</span>';
  document.body.appendChild(statusIndicator);
}

function updateStatus(message, color = null) {
  if (!statusIndicator) return;

  const span = statusIndicator.querySelector('span');
  if (span) {
    span.textContent = message;
  }

  if (color) {
    statusIndicator.style.background = color;
  } else {
    statusIndicator.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
  }
}

function removeStatusIndicator() {
  if (statusIndicator && statusIndicator.parentNode) {
    statusIndicator.parentNode.removeChild(statusIndicator);
    statusIndicator = null;
  }
}

// Observer to detect new questions
const observer = new MutationObserver((mutations) => {
  if (autoAnswerEnabled && !isProcessing) {
    checkForQuestion();
  }
});

// Start observing the document
setTimeout(() => {
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}, 1000);

// Hash image content (not just URL) for proper caching
async function hashImageContent(imageUrl) {
  try {
    // Download image
    const response = await fetch(imageUrl);
    const blob = await response.blob();

    // Convert to ArrayBuffer
    const arrayBuffer = await blob.arrayBuffer();

    // Hash the actual image bytes
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return hashHex.substring(0, 16); // First 16 chars
  } catch (error) {
    console.warn('Failed to hash image content, falling back to URL hash:', error);
    // Fallback: hash URL if image download fails
    const encoder = new TextEncoder();
    const data = encoder.encode(imageUrl);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.substring(0, 16);
  }
}

// Levenshtein distance for fuzzy string matching
function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(0));

  for (let i = 0; i <= len1; i++) matrix[0][i] = i;
  for (let j = 0; j <= len2; j++) matrix[j][0] = j;

  for (let j = 1; j <= len2; j++) {
    for (let i = 1; i <= len1; i++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,     // deletion
        matrix[j - 1][i] + 1,     // insertion
        matrix[j - 1][i - 1] + cost // substitution
      );
    }
  }

  return matrix[len2][len1];
}

// Find best matching answer from available options (fuzzy matching)
function findBestMatch(aiAnswer, availableOptions) {
  if (!availableOptions || availableOptions.length === 0) {
    return { match: null, confidence: 0, method: 'none' };
  }

  const normalized = normalizeAnswer(aiAnswer);

  // 1. Exact match
  for (const opt of availableOptions) {
    if (normalizeAnswer(opt) === normalized) {
      return { match: opt, confidence: 1.0, method: 'exact' };
    }
  }

  // 2. Contains match (AI answer contains option)
  for (const opt of availableOptions) {
    if (normalized.includes(normalizeAnswer(opt))) {
      return { match: opt, confidence: 0.9, method: 'contains' };
    }
  }

  // 3. Included in match (option contains AI answer)
  for (const opt of availableOptions) {
    if (normalizeAnswer(opt).includes(normalized)) {
      return { match: opt, confidence: 0.85, method: 'included' };
    }
  }

  // 4. Fuzzy match with Levenshtein distance
  let bestMatch = null;
  let minDistance = Infinity;
  let bestSimilarity = 0;

  for (const opt of availableOptions) {
    const optNorm = normalizeAnswer(opt);
    const distance = levenshteinDistance(normalized, optNorm);
    const maxLen = Math.max(normalized.length, optNorm.length);
    const similarity = 1 - (distance / maxLen);

    if (similarity > 0.7 && distance < minDistance) {
      minDistance = distance;
      bestMatch = opt;
      bestSimilarity = similarity;
    }
  }

  if (bestMatch) {
    return { match: bestMatch, confidence: bestSimilarity, method: 'fuzzy' };
  }

  // 5. No good match found - return first option as last resort
  return { match: availableOptions[0], confidence: 0.25, method: 'fallback' };
}

async function checkForQuestion() {
  if (isProcessing) return;

  // CHECK TURN FIRST - before doing anything else!
  const playerTurn = isPlayerTurn();

  if (!playerTurn) {
    if (!lastQuestionText || lastQuestionText !== 'NOT_YOUR_TURN') {
      updateStatus('Waiting for your turn...', 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)');
      lastQuestionText = 'NOT_YOUR_TURN';
    }
    return; // STOP HERE - don't process anything!
  }

  // Only continue if it's player's turn
  const questionElement = document.querySelector('p.text-lg.select-none.break-words');

  if (!questionElement) {
    if (lastQuestionText !== 'NO_QUESTION') {
      updateStatus('Auto-Answer Ready');
      lastQuestionText = 'NO_QUESTION';
    }
    return;
  }

  const questionText = questionElement.textContent.trim();

  if (!questionText) {
    return;
  }

  if (questionText === lastQuestionText) {
    return; // Already processed
  }

  // Try to find topic/category name
  let topicName = null;

  // Strategy 1: Look for links to /dashboard/sets/
  const setLinks = document.querySelectorAll('a[href*="/dashboard/sets/"]');
  for (const link of setLinks) {
    const text = link.textContent.trim();
    const computed = window.getComputedStyle(link);
    const isVisible = computed.display !== 'none' && computed.visibility !== 'hidden';
    if (text && text.length > 2 && text.length < 100 && isVisible) {
      topicName = text;
      break;
    }
  }

  // Strategy 2: Look for specific class names
  if (!topicName) {
    const topicCandidates = [
      document.querySelector('[class*="topic"]'),
      document.querySelector('[class*="category"]'),
      document.querySelector('[class*="quiz"]'),
      document.querySelector('[class*="set"]'),
      document.querySelector('[class*="theme"]')
    ].filter(el => el !== null);

    for (const elem of topicCandidates) {
      const text = elem.textContent.trim();
      if (text && text.length > 3 && text.length < 150 && !text.includes('?')) {
        topicName = text;
        break;
      }
    }
  }

  // Strategy 3: Look for headings
  if (!topicName) {
    const headings = document.querySelectorAll('h1, h2, h3, h4');
    for (const heading of headings) {
      const text = heading.textContent.trim();
      if (text && text.length > 3 && text.length < 150 && !text.includes('?')) {
        topicName = text;
        break;
      }
    }
  }

  // Strategy 4: Look for labels
  if (!topicName) {
    const allText = document.querySelectorAll('p, div, span');
    for (const elem of allText) {
      const text = elem.textContent.trim();
      if (text.includes('Téma:') || text.includes('Kategorie:') || text.includes('Sada:') || text.includes('Topic:')) {
        topicName = text.split(':')[1]?.trim();
        if (topicName && topicName.length > 3) break;
      }
    }
  }

  // Strategy 5: Look in page title
  if (!topicName) {
    const titleParts = document.title.split('|').map(s => s.trim());
    for (const part of titleParts) {
      if (part && part.length > 3 && part.length < 150 &&
          part !== 'Vyzyvatel.com' && !part.includes('Dashboard')) {
        topicName = part;
        break;
      }
    }
  }

  // Clear console for clean view
  console.clear();
  console.log('❓', topicName ? `[${topicName}]` : '', questionText);

  // Check if already answered (disabled buttons with text > 2 chars)
  const allButtons = document.querySelectorAll('button[data-slot="button"]');
  const foundAnsweredButton = Array.from(allButtons).some(btn => {
    const text = btn.textContent.trim();
    const isKeyboardButton = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '-'].includes(text);
    return btn.disabled && !isKeyboardButton && text.length > 2;
  });

  if (foundAnsweredButton) {
    updateStatus('Question answered!', 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)');
    return;
  }

  isProcessing = true;
  lastQuestionText = questionText;

  // HUMANIZER: Random delay to simulate human thinking (0.3-1.5 seconds)
  const humanDelay = 300 + Math.random() * 1200;
  updateStatus('Thinking...', 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)');

  await new Promise(resolve => setTimeout(resolve, humanDelay));

  updateStatus('Processing question...', 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)');

  // Check for image
  const questionContainer = questionElement.closest('div');
  const imageElement = questionContainer ? questionContainer.querySelector('img') : null;
  const imageUrl = imageElement ? (imageElement.src || imageElement.dataset.src) : null;

  // Detect question type
  const calculatorInput = document.querySelector('input#calculator-input') ||
                          document.querySelector('input[inputmode="decimal"]');
  const allButtonsForType = document.querySelectorAll('button[data-slot="button"]');
  const hasCalculatorButtons = Array.from(allButtonsForType).some(btn => {
    const text = btn.textContent.trim();
    return ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '-'].includes(text);
  });

  const isNumericQuestion = !!(calculatorInput || hasCalculatorButtons);

  let answers = [];
  if (!isNumericQuestion) {
    const answerButtons = Array.from(document.querySelectorAll('button[data-slot="button"]:not([disabled])'));
    answers = answerButtons.map(btn => {
      const textElement = btn.querySelector('p.select-none, p.font-semibold');
      return textElement ? textElement.textContent.trim() : '';
    }).filter(text => text.length > 0 && !['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '-'].includes(text));
  }

  try {
    // FIRST: Check memory for known answer (include image hash in cache key if present)
    let cacheKey = questionText;
    if (imageUrl) {
      // Hash actual image content (not just URL) for accurate caching
      const imageHash = await hashImageContent(imageUrl);
      cacheKey = `${questionText}|||IMG:${imageHash}`;
      console.log('🖼️ Image hash:', imageHash.substring(0, 8) + '...');
    }

    const cachedData = getFromMemory(cacheKey);
    let finalAnswer = null;

    if (cachedData) {
      // Use cached answer - NO API CALL!
      finalAnswer = cachedData.answer;

      // Show confidence in console
      const confidenceEmoji = cachedData.confidence > 0.9 ? '✓✓✓' :
                               cachedData.confidence > 0.7 ? '✓✓' : '✓';
      const confidencePercent = Math.round(cachedData.confidence * 100);

      console.log(`💾 ${finalAnswer} [${confidenceEmoji} ${confidencePercent}%]`);
      updateStatus(`Cached (${confidencePercent}%) 💰`, 'linear-gradient(135deg, #10b981 0%, #059669 100%)');
    } else {
      // Need to call AI - will cache result for next time
      if (imageUrl) {
        updateStatus('Analyzing image... 🖼️', 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)');
      } else {
        updateStatus('Calling AI... 💸', 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)');
      }

      // Send to background script for AI processing
      const response = await chrome.runtime.sendMessage({
        action: 'processQuestion',
        question: questionText,
        answers: answers,
        imageUrl: imageUrl, // Pass image URL if present
        topic: topicName // Pass topic/category for better context
      });

      if (response.success && response.answer) {
        finalAnswer = response.answer;
        console.log('🤖 ' + finalAnswer);
      } else {
        console.error('❌ Error:', response.error);
        updateStatus('Error: ' + response.error, 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)');
        return;
      }
    }

    if (finalAnswer) {
      // Track for result verification (only if not cached)
      if (!cachedData) {
        currentQuestion = questionText;
        currentAnswer = finalAnswer;
        currentCacheKey = cacheKey;
        waitingForResult = true;
      }

      // Another humanizer delay before submitting (0.2-0.5 seconds)
      const submitDelay = 200 + Math.random() * 300;
      updateStatus('Submitting...', 'linear-gradient(135deg, #06b6d4 0%, #0891b2 100%)');

      await new Promise(resolve => setTimeout(resolve, submitDelay));

      if (isNumericQuestion) {
        enterNumericAnswer(finalAnswer);
      } else {
        const answerButtons = Array.from(document.querySelectorAll('button[data-slot="button"]:not([disabled])'));
        selectAnswer(finalAnswer, answerButtons);
      }

      // Start result detection
      if (waitingForResult) {
        setTimeout(() => {
          detectAnswerResult();
        }, 800);
      }
    }
  } catch (error) {
    console.error('❌ Error:', error);
    updateStatus('Error occurred', 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)');
    lastQuestionText = '';
  } finally {
    setTimeout(() => {
      isProcessing = false;
    }, 1500);
  }
}

function selectAnswer(aiAnswer, buttons) {
  // Extract button texts
  const buttonTexts = buttons.map(btn => {
    const textElement = btn.querySelector('p.select-none, p.font-semibold, p');
    return textElement ? textElement.textContent.trim() : btn.textContent.trim();
  }).filter(text => text && text.length > 0);

  // Use fuzzy matching to find best match
  const matchResult = findBestMatch(aiAnswer, buttonTexts);

  if (matchResult.match && matchResult.confidence > 0.3) {
    // Find the button with this text
    const matchingButton = buttons.find(btn => {
      const textElement = btn.querySelector('p.select-none, p.font-semibold, p');
      const buttonText = textElement ? textElement.textContent.trim() : btn.textContent.trim();
      return buttonText === matchResult.match;
    });

    if (matchingButton) {
      // Log match quality
      if (matchResult.method !== 'exact') {
        console.log(`🎯 Fuzzy match (${matchResult.method}): "${aiAnswer}" → "${matchResult.match}" [${Math.round(matchResult.confidence * 100)}%]`);
      }

      setTimeout(() => {
        matchingButton.click();
        updateStatus('Answer clicked!', 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)');

        matchingButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        matchingButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }, 300);
      return;
    }
  }

  // Last resort - no good match found
  console.error('❌ No match found for:', aiAnswer, 'Options:', buttonTexts);
  updateStatus('Could not match answer', 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)');
}

// Detect if it's the player's turn
function isPlayerTurn() {
  // FOR TESTING: Set this to true to disable turn detection
  const DISABLE_TURN_CHECK = false; // Change to true to test without turn detection

  if (DISABLE_TURN_CHECK) {
    return true;
  }

  // Check if there's a question visible
  const questionElement = document.querySelector('p.text-lg.select-none.break-words');
  if (!questionElement || !questionElement.textContent.trim()) {
    return false; // No question = not in game
  }

  // Strategy 1: Check for ANSWER buttons specifically (with meaningful text, not keyboard buttons)
  const allButtons = document.querySelectorAll('button[data-slot="button"]:not([disabled])');
  const answerButtons = Array.from(allButtons).filter(btn => {
    const text = btn.textContent.trim();
    // Exclude keyboard buttons (0-9, ., -) and common UI buttons
    const isKeyboardButton = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '-'].includes(text);
    const isUIButton = ['Opustit hru', 'Připojit do hry', 'OK', 'Zrušit'].includes(text);
    // Answer buttons have longer text (> 2 chars) and are not keyboard/UI buttons
    return text.length > 2 && !isKeyboardButton && !isUIButton;
  });

  if (answerButtons.length > 0) {
    return true; // We have answer buttons available
  }

  // Strategy 2: Check for calculator input (numeric questions)
  const calculatorInput = document.querySelector('input#calculator-input') ||
                          document.querySelector('input[inputmode="decimal"]');

  if (calculatorInput && !calculatorInput.disabled) {
    return true; // Calculator is enabled
  }

  return false; // No answer buttons or calculator = not your turn
}

function enterNumericAnswer(numericAnswer) {
  let cleaned = numericAnswer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Remove thousands separators (spaces, commas, dots between digits)
  // But keep decimal point (dot after digits before more digits)
  cleaned = cleaned.replace(/(\d)[\s,](?=\d)/g, '$1'); // Remove space/comma between digits
  cleaned = cleaned.replace(/(\d)\.(?=\d{3})/g, '$1'); // Remove dot if followed by exactly 3 digits (thousands)

  const numberMatch = cleaned.match(/(-?\d+\.?\d*)/);
  const cleanNumber = numberMatch ? numberMatch[1] : cleaned;

  const inputField = document.querySelector('input#calculator-input') ||
                     document.querySelector('input[inputmode="decimal"]') ||
                     document.querySelector('input.font-mono') ||
                     document.querySelector('input[type="text"]');

  if (!inputField) {
    console.error('❌ Input field not found');
    updateStatus('Could not find input field', 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)');
    return;
  }

  setTimeout(() => {
    inputField.value = cleanNumber;
    inputField.dispatchEvent(new Event('input', { bubbles: true }));
    inputField.dispatchEvent(new Event('change', { bubbles: true }));

    setTimeout(() => {
      const submitButtons = Array.from(document.querySelectorAll('button[data-slot="button"]:not([disabled])'));
      const submitButton = submitButtons.find(btn => {
        const hasPlayIcon = btn.querySelector('svg.lucide-play');
        const hasGreenBg = btn.classList.contains('bg-green-600') || btn.classList.contains('bg-green-500');
        return (hasPlayIcon || hasGreenBg) && !btn.disabled;
      });

      if (submitButton) {
        submitButton.click();
        updateStatus('Answer submitted!', 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)');

        setTimeout(() => {
          const dialogButtons = Array.from(document.querySelectorAll('button[data-slot="button"]:not([disabled])'));
          if (dialogButtons.length === 2) {
            const emptyButtons = dialogButtons.filter(btn => btn.textContent.trim() === '');
            if (emptyButtons.length === 2) {
              emptyButtons[0].click();
            }
          }
        }, 800);
      } else {
        console.error('❌ Submit button not found');
      }
    }, 300);
  }, 200 + Math.random() * 300);
}

// Also check for text input fields (for number answers)
function checkForTextInput() {
  if (!isPlayerTurn()) return;

  const inputField = document.querySelector('input[type="text"], input[type="number"]');
  if (inputField && autoAnswerEnabled && !isProcessing) {
    // Handle text/number input questions
    // This can be extended based on the actual input field structure
    console.log('Text input detected');
  }
}
