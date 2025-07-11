#!/usr/bin/env node

/**
 * Test script for the feedback and iteration flow
 * This tests the new checkpoint and session resume functionality
 */

const fetch = require('node-fetch');

// Configuration
const MCP_SERVER_URL = 'http://localhost:3014/mcp';
const TEST_AGENT_ID = 'test-agent-iteration';

// MCP request helper
async function callMcpTool(tool, args) {
  const response = await fetch(MCP_SERVER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'call_tool',
      params: {
        name: tool,
        arguments: args
      }
    })
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(`MCP Error: ${result.error.message}`);
  }
  return result.result;
}

// Test scenarios
async function runTests() {
  console.log('🧪 Testing Claude Code Iteration Flow\n');

  try {
    // Test 1: Basic async execution (no checkpoint)
    console.log('Test 1: Basic async execution');
    const test1 = await callMcpTool('claude_code_async', {
      prompt: 'Create a file test_basic.txt with content "Basic async test"',
      agentId: TEST_AGENT_ID,
      workFolder: '/tmp'
    });
    console.log('✅ Response:', test1.content[0].text);
    console.log('');

    // Wait a bit for async completion
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Test 2: Checkpoint mode
    console.log('Test 2: Checkpoint mode execution');
    const test2 = await callMcpTool('claude_code_async', {
      prompt: 'Create a file checkpoint_test.txt with "Step 1 complete". Then write "Analysis complete" and pause.',
      agentId: TEST_AGENT_ID,
      interactionMode: 'checkpoint',
      checkpointPattern: 'Analysis complete|Step \\d+ complete',
      workFolder: '/tmp'
    });
    console.log('✅ Response:', test2.content[0].text);
    console.log('');

    // Wait for checkpoint
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Test 3: Resume from session (simulated - would need actual session ID from notification)
    console.log('Test 3: Session resume (simulated)');
    console.log('⚠️  Note: In real usage, you would get the session ID from the notification');
    console.log('    Example continuation call would be:');
    console.log(`
    await callMcpTool('claude_code_async', {
      prompt: 'Continue with step 2',
      agentId: TEST_AGENT_ID,
      sessionId: 'session-id-from-notification',
      workFolder: '/tmp'
    });
    `);

    // Test 4: Invalid checkpoint pattern
    console.log('Test 4: Invalid checkpoint pattern (error handling)');
    try {
      await callMcpTool('claude_code_async', {
        prompt: 'Test invalid pattern',
        agentId: TEST_AGENT_ID,
        interactionMode: 'checkpoint',
        checkpointPattern: '[invalid(regex',
        workFolder: '/tmp'
      });
      console.log('❌ Should have failed with invalid regex');
    } catch (error) {
      console.log('✅ Correctly caught error:', error.message);
    }
    console.log('');

    // Test 5: Invalid interaction mode
    console.log('Test 5: Invalid interaction mode');
    try {
      await callMcpTool('claude_code_async', {
        prompt: 'Test invalid mode',
        agentId: TEST_AGENT_ID,
        interactionMode: 'invalid-mode',
        workFolder: '/tmp'
      });
      console.log('❌ Should have failed with invalid mode');
    } catch (error) {
      console.log('✅ Correctly caught error:', error.message);
    }

    console.log('\n✅ All tests completed!');
    console.log('\n📝 Note: Check Matrix room or Letta agent for async notifications');
    console.log('    Notifications should include session IDs for continuation');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests
runTests().catch(console.error);