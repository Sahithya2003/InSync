const vscode = require('vscode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini API client with your API key
const genAI = new GoogleGenerativeAI('AIzaSyBJvWthlQV3wbSdsP-gTB17RCu1Vi7opNg');
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

function activate(context) {
	console.log('CodeWhisperer is now active');

	let codingGoal = '';
	let lastCode = '';
	// Timer variables
	let timerStartTime = null;
	let timerRunning = false;
	let timerElapsedTime = 0;
	let timerInterval = null;

	let panel = vscode.window.createWebviewPanel(
		'codeAssistant',
		'Code Assistant',
		vscode.ViewColumn.Beside,
		{
			enableScripts: true,
			retainContextWhenHidden: true
		}
	);

	// Initialize panel data storage
	panel.fixData = null;
	panel.targetDocument = null; // Store the target document reference
	panel.webview.html = getWebviewContent('Set a coding goal to begin');

	let setGoalCommand = vscode.commands.registerCommand('codeAssistant.setGoal', async () => {
		const goal = await vscode.window.showInputBox({
			placeHolder: "What are you trying to build today?",
			prompt: "Set your coding goal for this session"
		});
		if (goal) {
			codingGoal = goal;
			panel.webview.html = getWebviewContent(`Goal set: ${goal}`, true);

			// If there's already code in the editor, analyze it
			if (vscode.window.activeTextEditor) {
				const text = vscode.window.activeTextEditor.document.getText();
				panel.targetDocument = vscode.window.activeTextEditor.document; // Store document reference
				if (text.trim()) {
					lastCode = text;
					analyzeCode(text, codingGoal, panel);
				}
			}
		}
	});

	let changeListener = vscode.workspace.onDidChangeTextDocument(async (event) => {
		if (!codingGoal || !event.document) return;

		const text = event.document.getText();
		// Update our targetDocument reference
		panel.targetDocument = event.document;

		// Only analyze if there are meaningful changes and we have a goal set
		if (text === lastCode || text.trim() === '') return;

		// Debounce the analysis to avoid too many API calls
		clearTimeout(panel.analysisTimeout);
		panel.analysisTimeout = setTimeout(() => {
			lastCode = text;
			analyzeCode(text, codingGoal, panel);
		}, 1000); // Wait 1 second after typing stops
	});

	panel.webview.onDidReceiveMessage(async (message) => {
		if (message.command === 'requestHelp') {
			// Check for any available editor
			if (!vscode.window.activeTextEditor && vscode.window.visibleTextEditors.length === 0) {
				panel.webview.html = getWebviewContent('Please open a file to get help', true);
				return;
			}

			// Use active editor or first visible editor
			const editor = vscode.window.activeTextEditor || vscode.window.visibleTextEditors[0];
			panel.targetDocument = editor.document; // Store the document reference
			const text = editor.document.getText();
			provideAssistance(text, codingGoal, panel);
		} else if (message.command === 'applyFix') {
			// Get fix from Gemini with improved reliability
			getFixFromGemini(panel);

		}
		else if (message.command === 'openW3Schools') {
			vscode.env.openExternal(vscode.Uri.parse('https://www.w3schools.com/'));
		} else if (message.command === 'toggleTimer') {
			// Handle timer toggle
			if (timerRunning) {
				// Stop the timer
				timerRunning = false;
				clearInterval(timerInterval);
				timerElapsedTime += (Date.now() - timerStartTime);
			} else {
				// Start the timer
				timerRunning = true;
				timerStartTime = Date.now();
				timerInterval = setInterval(() => {
					// Update the timer display every second
					const currentElapsed = timerElapsedTime + (Date.now() - timerStartTime);
					updateTimerDisplay(currentElapsed, panel);
				}, 1000);
			}

			// Update the UI to reflect current timer state
			updateTimerDisplay(timerElapsedTime + (timerRunning ? (Date.now() - timerStartTime) : 0), panel);
		} else if (message.command === 'resetTimer') {
			// Reset the timer
			clearInterval(timerInterval);
			timerRunning = false;
			timerElapsedTime = 0;
			timerStartTime = null;
			updateTimerDisplay(0, panel);
		}
	});

	function updateTimerDisplay(milliseconds, panel) {
		// Format time as HH:MM:SS
		const totalSeconds = Math.floor(milliseconds / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;

		const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

		// Send the updated time and state to the webview
		panel.webview.postMessage({
			command: 'updateTimer',
			time: timeString,
			isRunning: timerRunning
		});
	}

	// New improved function to get the fix directly from Gemini
	async function getFixFromGemini(panel) {
		// Try to get an editor, either active or from visible editors
		let editor = vscode.window.activeTextEditor;

		// If no active editor, try to use the stored document reference
		if (!editor && panel.targetDocument) {
			try {
				// Try to show the document to make it active
				editor = await vscode.window.showTextDocument(panel.targetDocument);
				console.log('Reactivated editor using stored document reference');
			} catch (err) {
				console.error('Failed to reactivate editor:', err);
			}
		}

		// If still no editor, check visible editors
		if (!editor && vscode.window.visibleTextEditors.length > 0) {
			editor = vscode.window.visibleTextEditors[0];
			console.log('Using first visible editor as fallback');
		}

		// If still no editor, show error and return
		if (!editor) {
			vscode.window.showErrorMessage("No active editor to apply fix to. Please open a file first.");
			panel.webview.html = getWebviewContent('No active editor to apply fix to. Please open a file and try again.', true);
			return;
		}

		try {
			panel.webview.html = getWebviewContent('Generating fix from Gemini...', true);

			const code = editor.document.getText();
			panel.targetDocument = editor.document; // Store the document reference
			const goal = codingGoal || 'improve code quality';

			console.log('Requesting direct fix from Gemini for goal:', goal);

			// Improved prompt for cleaner, more reliable code fixes
			const prompt = `My goal is: "${goal}".
Here is my current code:
\`\`\`
${code}
\`\`\`

IMPORTANT: You must provide a complete fixed version of this code that addresses any issues.
DO NOT include any explanations.
DO NOT include any text before or after the code.
ONLY respond with the complete fixed code.`;

			// Add timeout for API call
			const abortController = new AbortController();
			const timeoutId = setTimeout(() => abortController.abort(), 15000); // 15-second timeout

			try {
				const result = await model.generateContent(prompt);
				clearTimeout(timeoutId);

				const responseText = result.response.text();
				console.log('Received response from Gemini:', responseText.substring(0, 100));

				// Extract the code using improved extraction logic
				const fixedCode = extractCodeImproved(responseText, code);

				if (fixedCode && fixedCode.trim() !== '') {
					console.log('Extracted fix:', fixedCode.substring(0, 100));

					// Update UI to indicate we're applying the fix
					panel.webview.html = getWebviewContent(
						'Fix generated! Applying to editor...',
						true
					);

					// Store the fix data and apply it
					panel.fixData = fixedCode;
					applyFixToEditor(panel);
				} else {
					console.error('Failed to extract valid code from response');
					panel.webview.html = getWebviewContent(
						"Couldn't extract a valid fix from Gemini's response. Please try again.",
						true,
						false
					);
				}
			} catch (error) {
				clearTimeout(timeoutId);
				if (error.name === 'AbortError') {
					console.error('Gemini API request timed out');
					panel.webview.html = getWebviewContent(
						"Request to Gemini timed out. Please try again.",
						true
					);
				} else {
					throw error; // Re-throw for the outer catch block
				}
			}
		} catch (error) {
			console.error('Failed to get fix from Gemini:', error);
			vscode.window.showErrorMessage(`Failed to get fix: ${error.message}`);
			panel.webview.html = getWebviewContent(
				`Error getting fix from Gemini: ${error.message}. Please try again later.`,
				true
			);
		}
	}

	context.subscriptions.push(setGoalCommand, changeListener, panel);
}

async function analyzeCode(code, goal, panel) {
	try {
		panel.webview.html = getWebviewContent('Analyzing your code...', true);

		console.log('Analyzing code for goal:', goal);

		const prompt = `I am coding with the goal: "${goal || 'general programming'}".
Here is my current code:
\`\`\`
${code}
\`\`\`

First, analyze if this code aligns with the stated goal.
If there are issues, provide a concise list (max 3) of key problems.
If the code looks good for the goal, just say it looks good.
Format your response in a very concise way, with no unnecessary text.
Do NOT explain the code line by line; focus only on potential issues.`;

		const result = await model.generateContent(prompt);
		const responseText = result.response.text();

		console.log('Analysis response received:', responseText.substring(0, 100) + '...');

		// Process the response to extract just the key insights
		const processedResponse = processAIResponse(responseText, goal);

		// Determine if the code has issues
		const hasIssues = !processedResponse.includes('looks good') &&
			!processedResponse.includes('Great job');

		console.log('Has issues:', hasIssues);

		panel.webview.html = getWebviewContent(
			processedResponse,
			true,
			hasIssues // Only show the fix button if there are issues
		);
	} catch (error) {
		console.error('Error analyzing code:', error);
		vscode.window.showErrorMessage(`Error analyzing code: ${error.message}`);
		panel.webview.html = getWebviewContent(
			`Error analyzing code. Please try again later.`,
			true
		);
	}
}

async function provideAssistance(code, goal, panel) {
	try {
		panel.webview.html = getWebviewContent('Generating assistance...', true);

		console.log('Requesting assistance for goal:', goal);

		// Improved prompt for better code extraction
		const prompt = `My goal is: "${goal || 'writing efficient code'}".
Here is my current code:
\`\`\`
${code}
\`\`\`

First, briefly explain the issue in 1-2 sentences.
Then, provide COMPLETE fixed code. Do not include partial fixes or code snippets.
Make sure the fixed code addresses any issues related to the goal.`;

		const result = await model.generateContent(prompt);
		const responseText = result.response.text();

		console.log('Gemini response received:', responseText.substring(0, 100) + '...');

		// Extract explanation and code
		const explanation = extractExplanation(responseText);
		const fixedCode = extractCodeImproved(responseText, code);

		console.log('Extracted explanation:', explanation);
		console.log('Extracted code block:', fixedCode ? 'Found' : 'Not found');

		let message;
		let showFixButton = false;

		if (fixedCode && fixedCode.trim() !== '') {
			message = explanation || "I found an issue with your code. Click 'Apply Fix' to update it.";
			showFixButton = true;
			panel.fixData = fixedCode;
		} else {
			message = "I couldn't generate a specific fix. Please try requesting help again.";
		}

		panel.webview.html = getWebviewContent(message, true, showFixButton);
	} catch (error) {
		console.error('Failed to get assistance:', error);
		vscode.window.showErrorMessage(`Failed to get assistance: ${error.message}`);
		panel.webview.html = getWebviewContent(
			`Error getting assistance. Please try again later.`,
			true
		);
	}
}

function processAIResponse(response, goal) {
	// Remove markdown formatting and extra explanations
	let processed = response
		.replace(/^```[\s\S]*?```$/gm, '') // Remove code blocks
		.replace(/^#.*$/gm, '')            // Remove headers
		.trim();

	// Focus on key issues only
	if (processed.length > 300) {
		// Extract just the key issues if response is too long
		let keyIssues = [];
		const lines = processed.split('\n').filter(line => line.trim());

		for (const line of lines) {
			if (line.includes('error') ||
				line.includes('issue') ||
				line.includes('problem') ||
				line.includes('incorrect') ||
				line.includes('missing')) {
				keyIssues.push(line.trim());
			}
		}

		if (keyIssues.length > 0) {
			return `Key Issues:\n${keyIssues.slice(0, 3).join('\n')}`;
		}

		// Fallback to a shorter version of the full message
		return `Analysis: ${processed.split('.')[0]}.`;
	}

	return processed;
}

// Improved code extraction function with multiple strategies
function extractCodeImproved(response, originalCode) {
	console.log('Extracting code using improved extractor...');

	// Strategy 1: Extract code between triple backticks
	const codeBlockRegex = /```(?:[\w]*\n)?([\s\S]*?)```/g;
	const matches = [...response.matchAll(codeBlockRegex)];

	if (matches.length > 0) {
		console.log('Found code block using standard regex');
		return matches[0][1].trim();
	}

	// Strategy 2: Look for indented blocks of code
	const indentedLines = response.split('\n').filter(line => line.startsWith('    ') || line.startsWith('\t'));
	if (indentedLines.length > 3) { // At least 3 lines to be considered a code block
		console.log('Found code block using indentation');
		return indentedLines.join('\n').trim();
	}

	// Strategy 3: If the response is very short, it might be just the code
	if (response.trim().length < 200 && (response.includes('=') || response.includes('print'))) {
		console.log('Using entire response as code (short response)');
		return response.trim();
	}

	// Strategy 4: Look for code-like patterns
	if (response.includes('print(') || response.includes('function') ||
		response.includes('return') || response.includes('var ') ||
		response.includes('const ') || response.includes('let ')) {

		// Find the start and end of what looks like code
		const lines = response.split('\n');
		let startIdx = -1;
		let endIdx = -1;

		for (let i = 0; i < lines.length; i++) {
			if ((lines[i].includes('=') || lines[i].includes('print(') ||
				lines[i].includes('function') || lines[i].includes('return')) &&
				startIdx === -1) {
				startIdx = i;
			}

			if (startIdx !== -1 && lines[i].trim() === '' && i > startIdx + 2) {
				endIdx = i;
				break;
			}
		}

		if (startIdx !== -1) {
			endIdx = endIdx === -1 ? lines.length : endIdx;
			console.log('Extracted code-like section from response');
			return lines.slice(startIdx, endIdx).join('\n').trim();
		}
	}

	// Strategy 5: Compare with original code and extract significant differences
	if (originalCode && originalCode.trim() !== '') {
		const originalLines = originalCode.split('\n');
		const responseLines = response.split('\n');

		for (const line of responseLines) {
			const trimmedLine = line.trim();
			// Check if this line is different from any original line and looks like code
			if (trimmedLine.length > 5 &&
				!originalLines.some(origLine => origLine.trim() === trimmedLine) &&
				(trimmedLine.includes('=') || trimmedLine.includes('print(') ||
					trimmedLine.includes('function') || trimmedLine.includes('return'))) {

				console.log('Found potential fix line:', trimmedLine);

				// Try to construct a fix based on this different line
				const newCode = originalLines.map(origLine => {
					// If the original line contains something similar to what we're changing
					if ((origLine.includes('print(') && trimmedLine.includes('print(')) ||
						(origLine.includes('=') && trimmedLine.includes('='))) {
						return trimmedLine;
					}
					return origLine;
				}).join('\n');

				return newCode;
			}
		}
	}

	console.log('Could not extract code using any strategy');
	return null;
}

function extractExplanation(response) {
	// Extract the first 1-2 sentences that are not code
	const withoutCode = response.replace(/```[\s\S]*?```/g, '').trim();
	const sentences = withoutCode.split(/[.!?]/).filter(s => s.trim().length > 0);

	if (sentences.length > 0) {
		return (sentences[0] + (sentences[1] ? '. ' + sentences[1] : '')).trim() + '.';
	}

	return '';
}

async function applyFixToEditor(panel) {
	// Try multiple strategies to get a valid editor
	let editor = vscode.window.activeTextEditor;

	// Strategy 1: If no active editor but we have a targetDocument, try to open it
	if (!editor && panel.targetDocument) {
		try {
			editor = await vscode.window.showTextDocument(panel.targetDocument);
			console.log('Successfully reactivated document for applying fix');
		} catch (err) {
			console.error('Failed to reactivate document:', err);
		}
	}

	// Strategy 2: If still no editor, try any visible editor
	if (!editor && vscode.window.visibleTextEditors.length > 0) {
		editor = vscode.window.visibleTextEditors[0];
		console.log('Using first visible editor as fallback for applying fix');
	}

	// If still no editor, show error and return
	if (!editor) {
		vscode.window.showErrorMessage("No active editor to apply fix to");
		panel.webview.html = getWebviewContent(
			"No active editor to apply fix to. Please open a file and try again.",
			true
		);
		return;
	}

	console.log('Applying fix. Fix data available:', !!panel.fixData);

	if (!panel.fixData) {
		vscode.window.showErrorMessage("No fix available to apply");
		return;
	}

	// Make sure the fix data is not empty and different from original
	const currentCode = editor.document.getText();
	if (panel.fixData.trim() === '') {
		vscode.window.showErrorMessage("Fix appears to be empty");
		return;
	}

	if (panel.fixData === currentCode) {
		vscode.window.showInformationMessage("Fix is identical to current code");
		return;
	}

	// Create a proper edit with timeout
	const applyEditPromise = new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			reject(new Error('Edit operation timed out'));
		}, 5000); // 5-second timeout for edit operation

		const fullRange = new vscode.Range(
			editor.document.positionAt(0),
			editor.document.positionAt(editor.document.getText().length)
		);

		editor.edit(editBuilder => {
			editBuilder.replace(fullRange, panel.fixData);
		}).then(success => {
			clearTimeout(timeoutId);
			resolve(success);
		}).catch(err => {
			clearTimeout(timeoutId);
			reject(err);
		});
	});

	// Handle the edit operation with proper error handling
	applyEditPromise.then(success => {
		if (success) {
			// Update UI after applying fix
			panel.webview.html = getWebviewContent(
				"Fix from Gemini applied successfully! ✅",
				true
			);
			console.log('Fix applied successfully');
		} else {
			panel.webview.html = getWebviewContent(
				"Failed to apply fix. Please try again.",
				true
			);
			console.log('Failed to apply fix');
		}
	}).catch(error => {
		console.error('Error applying fix:', error);
		panel.webview.html = getWebviewContent(
			`Error applying fix: ${error.message}. Please try again.`,
			true
		);
	});
}

function getWebviewContent(message, showHelpButton = false, showFixButton = false) {
	// Determine message type for styling
	let messageType = 'info';
	if (message.includes('Error') || message.includes('error') || message.includes('issue') || message.includes('Issue') || message.includes('Incorrect')) {
		messageType = 'error';
	} else if (message.includes('good') || message.includes('Great') || message.includes('success')) {
		messageType = 'success';
	} else if (message.includes('Analyzing') || message.includes('Generating')) {
		messageType = 'loading';
	}

	// Format the message for display
	const formattedMessage = message.replace(/\n/g, '<br>');

	return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
                    padding: 15px; 
                    background-color: #1e1e1e; 
                    color: #e0e0e0;
                    margin: 0;
                }
                .container { 
                    width: 100%;
                }
                .header {
                    margin-bottom: 20px;
                    display: flex;
                    align-items: center;
                }
                .header h2 {
                    margin: 0;
                    padding: 0;
                    color: #4CAF50;
                }
                .emoji {
                    font-size: 1.5em;
                    margin-right: 10px;
                }
                .card { 
                    background: #252526; 
                    padding: 15px; 
                    border-radius: 6px; 
                    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    margin-bottom: 15px;
                }
                .info { color: #e0e0e0; }
                .error { color: #ff6b6b; }
                .success { color: #4CAF50; }
                .loading { color: #FFD700; }
                button { 
                    background: #007acc; 
                    color: white; 
                    border: none; 
                    padding: 8px 12px; 
                    margin-top: 10px; 
                    margin-right: 10px;
                    cursor: pointer; 
                    border-radius: 4px;
                    font-weight: 500;
                    transition: background 0.2s;
                }
                button:hover { background: #005f9e; }
                .buttons {
                    display: flex;
                    gap: 10px;
                    flex-wrap: wrap;
                }
                .timer-card {
                    background: #2d2d2d;
                    padding: 12px;
                    border-radius: 6px;
                    margin-top: 15px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                .timer-display {
                    font-family: monospace;
                    font-size: 1.2em;
                    color: #e9e9e9;
                    padding: 5px 10px;
                    background: #1e1e1e;
                    border-radius: 4px;
                    margin-right: 10px;
                }
                .timer-buttons {
                    display: flex;
                    gap: 8px;
                }
                .timer-btn {
                    background: #2a2a2a;
                    color: #e0e0e0;
                    border: 1px solid #3a3a3a;
                    padding: 4px 8px;
                    cursor: pointer;
                    border-radius: 4px;
                    font-size: 0.9em;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .timer-btn:hover {
                    background: #3a3a3a;
                }
                .timer-btn.play { color: #4CAF50; }
                .timer-btn.pause { color: #FFA500; }
                .timer-btn.reset { color: #ff6b6b; }
                .timer-label {
                    font-size: 0.9em;
                    color: #b0b0b0;
                    margin-right: 10px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <span class="emoji">${messageType === 'success' ? '😊' :
			messageType === 'error' ? '😕' :
				messageType === 'loading' ? '⏳' : '🤔'
		}</span>
                    <h2>CodeWhisperer</h2>
                </div>
                
                <div class="card">
                    <p class="${messageType}">${formattedMessage}</p>
                    
                    <div class="buttons">
                        ${showHelpButton ? '<button onclick="sendHelpRequest()">Request Help</button>' : ''}
                        ${showFixButton ? '<button onclick="applyFix()">Apply Fix</button>' : ''}
                    </div>
                    
                    <div class="timer-card">
                        <div class="timer-label">Coding Time:</div>
                        <div class="timer-display" id="timer-display">00:00:00</div>
                        <div class="timer-buttons">
                            <button id="timer-toggle" class="timer-btn play" onclick="toggleTimer()">
                                ▶️ Play
                            </button>
                            <button class="timer-btn reset" onclick="resetTimer()">
                                🔄 Reset
                            </button>
                        </div>
                    </div>
					<button onclick="openW3Schools()">W3Schools Reference</button>
                </div>
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                const timerToggleBtn = document.getElementById('timer-toggle');
                const timerDisplay = document.getElementById('timer-display');
                let timerRunning = false;
                
                function sendHelpRequest() {
                    vscode.postMessage({ command: 'requestHelp' });
                }
                
                function applyFix() {
                    vscode.postMessage({ command: 'applyFix' });
                }
                function openW3Schools() {
    vscode.postMessage({ command: 'openW3Schools' });
}
                function toggleTimer() {
                    timerRunning = !timerRunning;
                    vscode.postMessage({ command: 'toggleTimer' });
                    
                    // Toggle button appearance
                    if (timerRunning) {
                        timerToggleBtn.innerHTML = '⏸️ Pause';
                        timerToggleBtn.classList.remove('play');
                        timerToggleBtn.classList.add('pause');
                    } else {
                        timerToggleBtn.innerHTML = '▶️ Play';
                        timerToggleBtn.classList.remove('pause');
                        timerToggleBtn.classList.add('play');
                    }
                }
                
                function resetTimer() {
                    vscode.postMessage({ command: 'resetTimer' });
                    timerRunning = false;
                    timerToggleBtn.innerHTML = '▶️ Play';
                    timerToggleBtn.classList.remove('pause');
                    timerToggleBtn.classList.add('play');
                    timerDisplay.textContent = '00:00:00';
                }
                
                // Listen for messages from the extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'updateTimer') {
                        // Update timer display
                        timerDisplay.textContent = message.time;
                        
                        // Update button state if needed
                        if (timerRunning !== message.isRunning) {
                            timerRunning = message.isRunning;
                            if (timerRunning) {
                                timerToggleBtn.innerHTML = '⏸️ Pause';
                                timerToggleBtn.classList.remove('play');
                                timerToggleBtn.classList.add('pause');
                            } else {
                                timerToggleBtn.innerHTML = '▶️ Play';
                                timerToggleBtn.classList.remove('pause');
                                timerToggleBtn.classList.add('play');
                            }
                        }
                    }
                });
            </script>
        </body>
        </html>
    `;
}

function deactivate() {
	console.log('CodeWhisperer is deactivated');
}

module.exports = {
	activate,
	deactivate
};