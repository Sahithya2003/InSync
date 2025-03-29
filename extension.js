const vscode = require('vscode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini API client with your API key
const genAI = new GoogleGenerativeAI('AIzaSyBJvWthlQV3wbSdsP-gTB17RCu1Vi7opNg');
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

function activate(context) {
	console.log('CodeWhisperer is now active');

	let codingGoal = '';
	let lastCode = '';
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
			if (!vscode.window.activeTextEditor) {
				panel.webview.html = getWebviewContent('Please open a file to get help', true);
				return;
			}

			const text = vscode.window.activeTextEditor.document.getText();
			provideAssistance(text, codingGoal, panel);
		} else if (message.command === 'applyFix') {
			// Instead of immediately applying a fix, we'll get it from Gemini first
			getFixFromGemini(panel);
		}
	});


// New function to get the fix directly from Gemini
	async function getFixFromGemini(panel) {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage("No active editor to apply fix to");
			return;
		}

		try {
			panel.webview.html = getWebviewContent('Generating fix from Gemini...', true);

			const code = editor.document.getText();
			const goal = codingGoal || 'improve code quality';

			console.log('Requesting direct fix from Gemini for goal:', goal);

			// Specialized prompt for getting a clean code fix
			const prompt = `My goal is: "${goal}".
Here is my current code:
\`\`\`
${code}
\`\`\`

IMPORTANT: You must provide a complete fixed version of this code that addresses any issues.
Do NOT explain the issues or the fixes.
Only respond with the fixed code, wrapped in triple backticks.
The code must be complete and ready to use.`;

			const result = await model.generateContent(prompt);
			const responseText = result.response.text();

			// Extract just the code block
			const fixedCode = extractCodeBlock(responseText);

			if (fixedCode && fixedCode.trim() !== '') {
				// Store the fix data and apply it
				panel.fixData = fixedCode;
				applyFixToEditor(panel);
			} else {
				// If we couldn't extract a code block, show an error
				panel.webview.html = getWebviewContent(
					"Couldn't generate a valid fix. Please try again.",
					true,
					false
				);
			}
		} catch (error) {
			console.error('Failed to get fix from Gemini:', error);
			vscode.window.showErrorMessage(`Failed to get fix: ${error.message}`);
			panel.webview.html = getWebviewContent(
				`Error getting fix from Gemini. Please try again later.`,
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

		// Modified prompt to be more direct and structured for better extraction
		const prompt = `My goal is: "${goal || 'writing efficient code'}".
Here is my current code:
\`\`\`
${code}
\`\`\`

IMPORTANT: You MUST provide a specific fix for this code.
Your answer MUST follow this exact format:
1. Brief explanation of the issue (1-2 sentences only)
2. The word "FIXED CODE:" on its own line 
3. Complete fixed code wrapped in triple backticks

Example format:
The issue is [explanation].

FIXED CODE:
\`\`\`
[complete fixed code here]
\`\`\``;

		const result = await model.generateContent(prompt);
		const responseText = result.response.text();

		console.log('Gemini response:', responseText.substring(0, 100) + '...');

		// Enhanced code extraction
		const fixedCode = extractCodeBlock(responseText);
		console.log('Extracted code block:', fixedCode ? 'Found' : 'Not found');

		// Create a simpler message for display
		const explanation = responseText
			.replace(/```[\s\S]*?```/g, '') // Remove code blocks
			.split('\n')
			.filter(line => line.trim()) // Remove empty lines
			.slice(0, 2) // Take first two non-empty lines
			.join(' ')
			.trim();

		let message;
		let showFixButton = false;

		if (fixedCode) {
			message = explanation || "I found an issue with your code. Click 'Apply Fix' to update it.";
			showFixButton = true;
			panel.fixData = fixedCode;
			console.log('Fix data set:', fixedCode.substring(0, 50) + '...');
		} else {
			message = "I couldn't generate a specific fix. Please try requesting help again.";

			// Try to generate a simple fix for common issues
			const simpleFixedCode = generateSimpleFix(code, goal);
			if (simpleFixedCode && simpleFixedCode !== code) {
				panel.fixData = simpleFixedCode; // Store the fix in the panel object
				showFixButton = true;
				message = "I found a potential issue. Click 'Apply Fix' to update your code.";
				console.log('Simple fix generated');
			}
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

function extractCodeBlock(response) {
	console.log('Extracting code block...');

	// Look for "FIXED CODE:" marker first
	const fixedCodeMarkerIndex = response.indexOf('FIXED CODE:');
	let searchText = response;

	if (fixedCodeMarkerIndex !== -1) {
		// Focus search on text after the marker
		searchText = response.substring(fixedCodeMarkerIndex);
		console.log('Found FIXED CODE marker');
	}

	// Enhanced regex to better match code blocks with or without language specifiers
	const codeBlockRegex = /```(?:[\w]*\n)?([\s\S]*?)```/g;
	const matches = [...searchText.matchAll(codeBlockRegex)];

	console.log('Code block matches found:', matches.length);

	if (matches.length > 0) {
		// Return the first code block found
		return matches[0][1].trim();
	}

	// Try a simpler regex as fallback
	const simpleRegex = /```([\s\S]*?)```/g;
	const simpleMatches = [...searchText.matchAll(simpleRegex)];

	console.log('Simple code block matches found:', simpleMatches.length);

	if (simpleMatches.length > 0) {
		return simpleMatches[0][1].trim();
	}

	// Last resort: look for code without proper markdown formatting
	const indentedBlockRegex = /\n([ \t]+[\w\s=();.{}[\]"'+-/<>!]+\n)+/g;
	const indentedMatches = [...searchText.matchAll(indentedBlockRegex)];

	if (indentedMatches.length > 0) {
		return indentedMatches[0][0].trim();
	}

	return null;
}

function generateSimpleFix(code, goal) {
	// This is a simple backup for when the AI doesn't provide a code block
	console.log('Attempting to generate simple fix');

	// You can expand this with more patterns based on common errors
	if (code.includes('print(a-b)') && goal && goal.toLowerCase().includes('add')) {
		return code.replace('print(a-b)', 'print(a+b)');
	}

	if (code.includes('print(a+b)') && goal && goal.toLowerCase().includes('subtract')) {
		return code.replace('print(a+b)', 'print(a-b)');
	}

	// Handle other common fixes
	if (code.includes('print(a=b)')) {
		return code.replace('print(a=b)', 'print(a==b)');
	}

	// Check for missing semicolons in JavaScript
	if ((code.includes('javascript') || code.includes('function') || code.includes('const ')) &&
		!code.includes('python')) {
		let fixedCode = code;
		let lines = code.split('\n');
		let hasChanges = false;

		for (let i = 0; i < lines.length; i++) {
			let line = lines[i].trim();
			if (line &&
				!line.endsWith(';') &&
				!line.endsWith('{') &&
				!line.endsWith('}') &&
				!line.startsWith('//') &&
				!line.startsWith('function') &&
				!line.startsWith('if') &&
				!line.startsWith('else') &&
				!line.startsWith('for') &&
				!line.startsWith('while')) {
				lines[i] = lines[i] + ';';
				hasChanges = true;
			}
		}

		if (hasChanges) {
			return lines.join('\n');
		}
	}

	// Remove any erroneous numbers like "55" that might be in the code
	if (code.includes('55') && !code.match(/[a-zA-Z0-9_]55[a-zA-Z0-9_]/)) {
		return code.replace(/\b55\b/g, '');
	}

	return code; // Return original code if no patterns match
}

function applyFixToEditor(panel) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage("No active editor to apply fix to");
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

	const fullRange = new vscode.Range(
		editor.document.positionAt(0),
		editor.document.positionAt(editor.document.getText().length)
	);

	editor.edit(editBuilder => {
		editBuilder.replace(fullRange, panel.fixData);
	}).then(success => {
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
                </div>
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                
                function sendHelpRequest() {
                    vscode.postMessage({ command: 'requestHelp' });
                }
                
                function applyFix() {
                    vscode.postMessage({ command: 'applyFix' });
                }
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