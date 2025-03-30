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
		'InSync',
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
		.replace(/^#.*$/gm, '') // Remove headers 
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
	const indentedLines = response.split('\n').filter(line => line.startsWith(' ') || line.startsWith('\t'));
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
	function getThemeColorIntegrationStyles() {
		return `
    <style>
      :root {
        /* Get colors from VSCode theme */
        --bg-primary: var(--vscode-editor-background);
        --bg-secondary: var(--vscode-sideBar-background);
        --bg-tertiary: var(--vscode-editorWidget-background);
        --text-primary: var(--vscode-foreground);
        --text-secondary: var(--vscode-descriptionForeground);
        --accent-primary: var(--vscode-button-background);
        --accent-hover: var(--vscode-button-hoverBackground);
        --accent-secondary: var(--vscode-progressBar-background);
        --error-color: var(--vscode-errorForeground);
        --warning-color: var(--vscode-editorWarning-foreground, #ff9800);
        --success-color: var(--vscode-terminal-ansiGreen, #4CAF50);
        --info-color: var(--vscode-terminal-ansiBlue, #2196F3);
        --border-radius: 4px;
        --shadow: var(--vscode-widget-shadow);
      }

      body {
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif);
        padding: 0;
        background-color: var(--bg-primary);
        color: var(--text-primary);
        margin: 0;
        line-height: 1.5;
        font-size: var(--vscode-font-size, 14px);
      }

      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.05));
      }

      button {
        background: var(--accent-primary);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 6px 14px;
        cursor: pointer;
        border-radius: var(--border-radius);
        font-weight: 500;
        transition: var(--transition);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.95em;
      }

      button:hover {
        background: var(--accent-hover);
      }

      .timer-card {
        background: var(--bg-tertiary);
        border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.05));
      }

      .timer-display-container {
        background: var(--bg-primary);
      }

      .timer-btn {
        background: var(--vscode-button-secondaryBackground, rgba(255, 255, 255, 0.05));
        color: var(--vscode-button-secondaryForeground, var(--text-primary));
        border: 1px solid var(--vscode-button-border, rgba(255, 255, 255, 0.1));
      }

      .timer-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground, rgba(255, 255, 255, 0.1));
      }

      .resource-link {
        background: var(--bg-tertiary);
        border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.05));
      }

      .resource-link:hover {
        background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.1));
      }

      .progress-bar {
        background: var(--accent-secondary);
      }

      /* Theme-specific styles for message types */
      .info { color: var(--text-primary); background: var(--bg-tertiary); }
      .error { color: var(--error-color); background: var(--vscode-inputValidation-errorBackground, rgba(244, 67, 54, 0.1)); }
      .success { color: var(--success-color); background: var(--vscode-inputValidation-infoBackground, rgba(76, 175, 80, 0.1)); }
      .loading { color: var(--warning-color); background: var(--vscode-inputValidation-warningBackground, rgba(255, 152, 0, 0.1)); }
    </style>
  `;
	}
	return ` 
<!DOCTYPE html> 
<html> 
<head> 
${getThemeColorIntegrationStyles()}
<style> 

body { 
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif; 
padding: 0; 
background-color: var(--bg-secondary); 
color: var(--text-primary); 
margin: 0; 
line-height: 1.5; 
font-size: 14px; 
} 
.container { 
width: 100%; 
padding: 20px; 
box-sizing: border-box; 
} 
.header { 
display: flex; 
align-items: center; 
margin-bottom: 20px; 
padding-bottom: 15px; 
border-bottom: 1px solid rgba(100, 97, 97, 0); 
} 
.header-title { 
display: flex; 
align-items: center; 
} 
.header h2 { 
margin: 0; 
padding: 0; 
font-size: 1.6em; 
color: var(--text-primary); 
font-weight: 600; 
} 
.emoji { 
font-size: 1.6em; 
margin-right: 12px; 
} 
.card { 
background: var(--bg-primary); 
padding: 20px; 
border-radius: var(--border-radius); 
box-shadow: var(--shadow); 
margin-bottom: 20px; 
transition: var(--transition); 
border: 1px solid rgba(255, 255, 255, 0.05); 
} 
.card:hover { 
box-shadow: 0 6px 16px rgba(94, 92, 92, 0.08); 
} 
.message-container { 
padding: 15px; 
border-radius: var(--border-radius); 
margin-bottom: 20px; 
background: rgba(255, 255, 255, 0.05); 
} 
.info { color: var(--text-primary); } 
.error { color: var(--error-color); background: rgba(244, 67, 54, 0.1); } 
.success { color: var(--success-color); background: rgba(76, 175, 80, 0.1); } 
.loading { color: var(--warning-color); background: rgba(255, 152, 0, 0.1); } 
.buttons { 
display: flex; 
gap: 12px; 
flex-wrap: wrap; 
margin-top: 20px; 
} 
button { 
background: var(--accent-primary); 
color: white; 
border: none; 
padding: 10px 16px; 
cursor: pointer; 
border-radius: var(--border-radius); 
font-weight: 500; 
transition: var(--transition); 
display: flex; 
align-items: center; 
justify-content: center; 
font-size: 0.95em; 
} 
button:hover { 
background: var(--accent-hover); 
transform: translateY(-2px); 
box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2); 
} 
button:active { 
transform: translateY(0); 
} 
.btn-icon { 
margin-right: 8px; 
font-size: 1.1em; 
} 
.card-title { 
margin: 0 0 15px 0; 
font-size: 1.1em; 
color: var(--text-primary); 
font-weight: 600; 
} 
/* Timer Card */ 
.timer-card { 
background: var(--bg-tertiary); 
padding: 16px; 
border-radius: var(--border-radius); 
margin-top: 20px; 
display: flex; 
flex-direction: column; 
gap: 15px; 
border: 1px solid rgba(255, 255, 255, 0.05); 
} 
.timer-header { 
display: flex; 
align-items: center; 
justify-content: space-between; 
margin-bottom: 5px; 
} 
.timer-label { 
font-size: 1em; 
color: var(--text-secondary); 
font-weight: 600; 
display: flex; 
align-items: center; 
} 
.timer-label-icon { 
margin-right: 8px; 
color: var(--info-color); 
} 
.timer-display-container { 
display: flex; 
align-items: center; 
justify-content: center; 
padding: 12px; 
background: rgba(0, 0, 0, 0.2); 
border-radius: var(--border-radius); 
} 
.timer-display { 
font-family: monospace; 
font-size: 1.6em; 
color: var(--text-primary); 
font-weight: bold; 
} 
.timer-actions { 
display: flex; 
justify-content: space-between; 
gap: 10px; 
} 
.timer-btn { 
background: rgba(255, 255, 255, 0.05); 
color: var(--text-primary); 
border: 1px solid rgba(255, 255, 255, 0.1); 
padding: 10px; 
cursor: pointer; 
border-radius: var(--border-radius); 
font-size: 0.9em; 
display: flex; 
align-items: center; 
justify-content: center; 
transition: var(--transition); 
flex: 1; 
} 
.timer-btn:hover { 
background: rgba(255, 255, 255, 0.1); 
transform: translateY(-2px); 
} 
.timer-btn:active { 
transform: translateY(0); 
} 
.timer-btn-icon { 
margin-right: 8px; 
font-size: 1.1em; 
} 
.timer-btn.play { color: var(--success-color); } 
.timer-btn.pause { color: var(--warning-color); } 
.timer-btn.reset { color: var(--error-color); } 
/* Resource links card */ 
.resources-card { 
margin-top: 20px; 
display: flex; 
flex-direction: column; 
gap: 10px; 
} 
.resources-header { 
display: flex; 
align-items: center; 
margin-bottom: 10px; 
} 
.resources-title { 
font-size: 1em; 
color: var(--text-secondary); 
font-weight: 600; 
margin: 0; 
} 
.resources-grid { 
display: grid; 
grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); 
gap: 10px; 
} 
.resource-link { 
background: rgba(255, 255, 255, 0.05); 
border-radius: var(--border-radius); 
padding: 12px; 
text-align: center; 
cursor: pointer; 
transition: var(--transition); 
border: 1px solid rgba(255, 255, 255, 0.05); 
display: flex; 
flex-direction: column; 
align-items: center; 
justify-content: center; 
gap: 8px; 
} 
.resource-link:hover { 
background: rgba(255, 255, 255, 0.1); 
transform: translateY(-2px); 
box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2); 
} 
.resource-icon { 
font-size: 1.5em; 
color: var(--info-color); 
} 
.resource-text { 
font-size: 0.9em; 
color: var(--text-primary); 
} 
/* Progress bar for loading state */ 
.progress-container { 
width: 100%; 
height: 4px; 
background: rgba(255, 255, 255, 0.1); 
border-radius: 2px; 
overflow: hidden; 
margin-top: 15px; 
} 
.progress-bar { 
height: 100%; 
width: 30%; 
background: var(--info-color); 
border-radius: 2px; 
animation: progressAnimation 1.5s ease-in-out infinite; 
} 
@keyframes progressAnimation { 
0% { 
transform: translateX(-100%); 
} 
100% { 
transform: translateX(400%); 
} 
} 
/* Tooltip */ 
.tooltip { 
position: relative; 
display: inline-block; 
} 
.tooltip:hover .tooltip-text { 
visibility: visible; 
opacity: 1; 
} 
.tooltip-text { 
visibility: hidden; 
background-color: rgba(0, 0, 0, 0.8); 
color: #fff; 
text-align: center; 
border-radius: 6px; 
padding: 8px 12px; 
position: absolute; 
z-index: 1; 
bottom: 125%; 
left: 50%; 
transform: translateX(-50%); 
opacity: 0; 
transition: opacity 0.3s; 
font-size: 0.85em; 
width: 150px; 
pointer-events: none; 
} 
.tooltip-text::after { 
content: ""; 
position: absolute; 
top: 100%; 
left: 50%; 
margin-left: -5px; 
border-width: 5px; 
border-style: solid; 
border-color: rgba(0, 0, 0, 0.8) transparent transparent transparent; 
} 
</style> 
</head> 
<body> 
<div class="container"> 
<div class="header"> 
<div class="header-title"> 
<span class="emoji"> 
${messageType === 'success' ? '✨' :
			messageType === 'error' ? '❗' :
				messageType === 'loading' ? '⚙️' : '💡'
		} 
</span> 
<h2>InSync</h2>
</div> 
</div> 
<div class="card"> 
<div class="message-container ${messageType}"> 
<p>${formattedMessage}</p> 
${messageType === 'loading' ?
			`<div class="progress-container"> 
<div class="progress-bar"></div> 
</div>` : ''
		} 
</div> 
<div class="buttons"> 
${showHelpButton ?
			`<button onclick="sendHelpRequest()"> 
<span class="btn-icon">🔍</span> Request Help 
</button>` : ''
		} 
${showFixButton ?
			`<button onclick="applyFix()"> 
<span class="btn-icon">✅</span> Apply Fix 
</button>` : ''
		} 
</div> 
<!-- Timer Card --> 
<div class="timer-card"> 
<div class="timer-header"> 
<div class="timer-label"> 
<span class="timer-label-icon">⏱️</span> 
Coding Session 
</div> 
</div> 
<div class="timer-display-container"> 
<div class="timer-display" id="timer-display">00:00:00</div> 
</div> 
<div class="timer-actions"> 
<button id="timer-toggle" class="timer-btn play" onclick="toggleTimer()"> 
<span class="timer-btn-icon">▶️</span> Start Coding 
</button> 
<button class="timer-btn reset" onclick="resetTimer()"> 
<span class="timer-btn-icon">🔄</span> Reset 
</button> 
</div> 
</div> 
<!-- Resources Card --> 
<div class="resources-card"> 
<div class="resources-header"> 
<h3 class="resources-title">Helpful Resources</h3> 
</div> 
<div class="resources-grid"> 
<div class="resource-link tooltip" onclick="openW3Schools()"> 
<span class="resource-icon">📚</span> 
<span class="resource-text">W3Schools</span> 
<span class="tooltip-text">HTML, CSS, JS references</span> 
</div> 
<div class="resource-link tooltip" onclick="openMDN()"> 
<span class="resource-icon">🌐</span> 
<span class="resource-text">MDN Web Docs</span> 
<span class="tooltip-text">Comprehensive web documentation</span> 
</div> 
<div class="resource-link tooltip" onclick="openStackOverflow()"> 
<span class="resource-icon">🔍</span> 
<span class="resource-text">Stack Overflow</span> 
<span class="tooltip-text">Find answers to coding questions</span> 
</div> 
<div class="resource-link tooltip" onclick="openGitHub()"> 
<span class="resource-icon">📦</span> 
<span class="resource-text">GitHub</span> 
<span class="tooltip-text">Browse repositories for examples</span> 
</div> 
</div> 
</div> 
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
function openMDN() { 
vscode.postMessage({ command: 'openResource', url: 'https://developer.mozilla.org/' }); 
} 
function openStackOverflow() { 
vscode.postMessage({ command: 'openResource', url: 'https://stackoverflow.com/' }); 
} 
function openGitHub() { 
vscode.postMessage({ command: 'openResource', url: 'https://github.com/' }); 
} 
function toggleTimer() { 
timerRunning = !timerRunning; 
vscode.postMessage({ command: 'toggleTimer' }); 
// Toggle button appearance 
if (timerRunning) { 
timerToggleBtn.innerHTML = '<span class="timer-btn-icon">⏸️</span> Pause'; 
timerToggleBtn.classList.remove('play'); 
timerToggleBtn.classList.add('pause'); 
} else { 
timerToggleBtn.innerHTML = '<span class="timer-btn-icon">▶️</span> Start Coding'; 
timerToggleBtn.classList.remove('pause'); 
timerToggleBtn.classList.add('play'); 
} 
} 
function resetTimer() { 
vscode.postMessage({ command: 'resetTimer' }); 
timerRunning = false; 
timerToggleBtn.innerHTML = '<span class="timer-btn-icon">▶️</span> Start Coding'; 
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
timerToggleBtn.innerHTML = '<span class="timer-btn-icon">⏸️</span> Pause'; 
timerToggleBtn.classList.remove('play'); 
timerToggleBtn.classList.add('pause'); 
} else { 
timerToggleBtn.innerHTML = '<span class="timer-btn-icon">▶️</span> Start Coding'; 
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

