import { spawn } from 'child_process';
import claudeStatusTracker from './claude-status-tracker.js';

let activeClaudeProcesses = new Map(); // Track active processes by session ID

async function spawnClaude(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, permissionMode } = options;
    let capturedSessionId = sessionId; // Track session ID throughout the process
    let sessionCreatedSent = false; // Track if we've already sent session-created event
    
    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false
    };
  
    // Build Claude CLI command - start with print/resume flags first
    const args = [];
    
    // Add print flag with command if we have a command
    if (command && command.trim()) {
      args.push('--print', command);
    }
    
    // Add resume flag if resuming
    if (resume && sessionId) {
      args.push('--resume', sessionId);
    }
    
    // Add basic flags
    args.push('--output-format', 'stream-json', '--verbose');
    
    // Add model for new sessions
    if (!resume) {
      args.push('--model', 'sonnet');
    }
    
    // Add permission mode if specified (works for both new and resumed sessions)
    if (permissionMode && permissionMode !== 'default') {
      args.push('--permission-mode', permissionMode);
      console.log('🔒 Using permission mode:', permissionMode);
    }
    
    // Add tools settings flags
    // Don't use --dangerously-skip-permissions when in plan mode
    if (settings.skipPermissions && permissionMode !== 'plan') {
      args.push('--dangerously-skip-permissions');
      console.log('⚠️  Using --dangerously-skip-permissions (skipping other tool settings)');
    } else {
      // Only add allowed/disallowed tools if not skipping permissions
      
      // Collect all allowed tools, including plan mode defaults
      let allowedTools = [...(settings.allowedTools || [])];
      
      // Add plan mode specific tools
      if (permissionMode === 'plan') {
        const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite'];
        // Add plan mode tools that aren't already in the allowed list
        for (const tool of planModeTools) {
          if (!allowedTools.includes(tool)) {
            allowedTools.push(tool);
          }
        }
        console.log('📝 Plan mode: Added default allowed tools:', planModeTools);
      }
      
      // Add allowed tools
      if (allowedTools.length > 0) {
        for (const tool of allowedTools) {
          args.push('--allowedTools', tool);
          console.log('✅ Allowing tool:', tool);
        }
      }
      
      // Add disallowed tools
      if (settings.disallowedTools && settings.disallowedTools.length > 0) {
        for (const tool of settings.disallowedTools) {
          args.push('--disallowedTools', tool);
          console.log('❌ Disallowing tool:', tool);
        }
      }
      
      // Log when skip permissions is disabled due to plan mode
      if (settings.skipPermissions && permissionMode === 'plan') {
        console.log('📝 Skip permissions disabled due to plan mode');
      }
    }
    
    // Use cwd (actual project directory) instead of projectPath (Claude's metadata directory)
    const workingDir = cwd || process.cwd();
    console.log('Spawning Claude CLI:', 'claude', args.map(arg => {
      const cleanArg = arg.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      return cleanArg.includes(' ') ? `"${cleanArg}"` : cleanArg;
    }).join(' '));
    console.log('Working directory:', workingDir);
    console.log('Session info - Input sessionId:', sessionId, 'Resume:', resume);
    console.log('🔍 Full command args:', args);
    
    const claudeProcess = spawn('claude', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env } // Inherit all environment variables
    });
    
    // Store process reference for potential abort
    const processKey = capturedSessionId || sessionId || Date.now().toString();
    activeClaudeProcesses.set(processKey, claudeProcess);
    
    // Track job in status tracker
    const jobId = `claude-${processKey}`;
    claudeStatusTracker.startJob(jobId, {
      type: 'claude-cli',
      command: command?.slice(0, 100), // Truncate long commands
      projectPath: projectPath,
      workingDir: workingDir,
      sessionId: sessionId,
      resume: resume,
      toolsSettings: settings
    });
    
    // Handle stdout (streaming JSON responses)
    claudeProcess.stdout.on('data', (data) => {
      const rawOutput = data.toString();
      console.log('📤 Claude CLI stdout:', rawOutput);
      
      const lines = rawOutput.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const response = JSON.parse(line);
          console.log('📄 Parsed JSON response:', response);
          
          // Capture session ID if it's in the response
          if (response.session_id && !capturedSessionId) {
            capturedSessionId = response.session_id;
            console.log('📝 Captured session ID:', capturedSessionId);
            
            // Update process key with captured session ID
            if (processKey !== capturedSessionId) {
              activeClaudeProcesses.delete(processKey);
              activeClaudeProcesses.set(capturedSessionId, claudeProcess);
            }
            
            // Update job with session ID
            claudeStatusTracker.updateJob(jobId, { 
              sessionId: capturedSessionId,
              capturedAt: new Date()
            });
            
            // Send session-created event only once for new sessions
            if (!sessionId && !sessionCreatedSent) {
              sessionCreatedSent = true;
              ws.send(JSON.stringify({
                type: 'session-created',
                sessionId: capturedSessionId
              }));
            }
          }
          
          // Track tool usage and other events
          if (response.tool_use) {
            claudeStatusTracker.updateJob(jobId, { 
              lastTool: response.tool_use.name,
              toolCallCount: (claudeStatusTracker.getJob(jobId)?.toolCallCount || 0) + 1
            });
          }
          
          // Send parsed response to WebSocket
          ws.send(JSON.stringify({
            type: 'claude-response',
            data: response
          }));
        } catch (parseError) {
          console.log('📄 Non-JSON response:', line);
          // If not JSON, send as raw text
          ws.send(JSON.stringify({
            type: 'claude-output',
            data: line
          }));
        }
      }
    });
    
    // Handle stderr
    claudeProcess.stderr.on('data', (data) => {
      console.error('Claude CLI stderr:', data.toString());
      ws.send(JSON.stringify({
        type: 'claude-error',
        error: data.toString()
      }));
    });
    
    // Handle process completion
    claudeProcess.on('close', (code) => {
      console.log(`Claude CLI process exited with code ${code}`);
      
      // Clean up process reference
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeClaudeProcesses.delete(finalSessionId);
      
      // Complete job in status tracker
      claudeStatusTracker.completeJob(jobId, {
        exitCode: code,
        finalSessionId: finalSessionId,
        error: code !== 0 ? `Process exited with code ${code}` : null
      });
      
      ws.send(JSON.stringify({
        type: 'claude-complete',
        exitCode: code,
        isNewSession: !sessionId && !!command // Flag to indicate this was a new session
      }));
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Claude CLI exited with code ${code}`));
      }
    });
    
    // Handle process errors
    claudeProcess.on('error', (error) => {
      console.error('Claude CLI process error:', error);
      
      // Clean up process reference on error
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeClaudeProcesses.delete(finalSessionId);
      
      // Complete job with error in status tracker
      claudeStatusTracker.completeJob(jobId, {
        error: error.message,
        errorType: 'process-error'
      });
      
      ws.send(JSON.stringify({
        type: 'claude-error',
        error: error.message
      }));
      
      reject(error);
    });
    
    // Handle stdin for interactive mode
    if (command) {
      // For --print mode with arguments, we don't need to write to stdin
      claudeProcess.stdin.end();
    } else {
      // For interactive mode, we need to write the command to stdin if provided later
      // Keep stdin open for interactive session
      if (command !== undefined) {
        claudeProcess.stdin.write(command + '\n');
        claudeProcess.stdin.end();
      }
      // If no command provided, stdin stays open for interactive use
    }
  });
}

function abortClaudeSession(sessionId) {
  const process = activeClaudeProcesses.get(sessionId);
  if (process) {
    console.log(`🛑 Aborting Claude session: ${sessionId}`);
    
    // Abort job in status tracker
    const jobId = `claude-${sessionId}`;
    claudeStatusTracker.abortJob(jobId);
    
    process.kill('SIGTERM');
    activeClaudeProcesses.delete(sessionId);
    return true;
  }
  return false;
}

export {
  spawnClaude,
  abortClaudeSession
};