#!/usr/bin/env node

/**
 * Test script for Claude Code status integration
 */

const fetch = require('node-fetch');

const AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInVzZXJuYW1lIjoiT2N1bGFpciIsImlhdCI6MTc1MjIxNzA5OX0.vzXo2GnGvwF-WlH4M6hZBk_9TcCCNI_Q0mlp75QOGeI';

async function testUIServerStatus() {
  console.log('🧪 Testing UI Server Status Endpoint\n');
  
  try {
    const response = await fetch('http://127.0.0.1:3012/api/claude-status', {
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const status = await response.json();
    console.log('✅ UI Server Status:');
    console.log('  Active Jobs:', status.activeJobs.length);
    console.log('  Stats:', status.stats);
    console.log('  System:', {
      uptime: Math.round(status.system.uptime / 60) + ' minutes',
      memory: Math.round(status.system.memory.heapUsed / 1024 / 1024) + ' MB'
    });
    
    if (status.mcpServer && !status.mcpServer.error) {
      console.log('  MCP Server:', status.mcpServer);
    }
  } catch (error) {
    console.error('❌ UI Server Status Error:', error.message);
  }
}

async function testMCPServerStatus() {
  console.log('\n🧪 Testing MCP Server Status Endpoint\n');
  
  try {
    const response = await fetch('http://127.0.0.1:3014/status');
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const status = await response.json();
    console.log('✅ MCP Server Status:');
    console.log('  Active Jobs:', status.activeJobs.length);
    console.log('  Stats:', status.stats);
    console.log('  Recent Completed:', status.recentCompleted.length);
  } catch (error) {
    console.error('❌ MCP Server Status Error:', error.message);
  }
}

async function testAsyncJob() {
  console.log('\n🧪 Testing Async Job Tracking\n');
  
  const MCP_SERVER_URL = 'http://127.0.0.1:3014/mcp';
  const TEST_AGENT_ID = 'test-status-agent';
  
  try {
    // Start an async job
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
          name: 'claude_code_async',
          arguments: {
            prompt: 'echo "Testing status integration" > /tmp/status_test.txt',
            agentId: TEST_AGENT_ID,
            workFolder: '/tmp'
          }
        }
      })
    });
    
    const result = await response.json();
    if (result.error) {
      throw new Error(`MCP Error: ${result.error.message}`);
    }
    
    console.log('✅ Started async job:', result.result.content[0].text);
    
    // Wait a bit for job to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Check status again
    console.log('\n📊 Checking status after job start...');
    await testMCPServerStatus();
    
  } catch (error) {
    console.error('❌ Async Job Error:', error.message);
  }
}

async function testWebSocketStatusUpdates() {
  console.log('\n🧪 Testing WebSocket Status Updates\n');
  
  const WebSocket = require('ws');
  
  try {
    const ws = new WebSocket(`ws://127.0.0.1:3012/ws?token=${AUTH_TOKEN}`);
    
    ws.on('open', () => {
      console.log('✅ WebSocket connected');
      console.log('   Listening for status updates...');
      
      // Keep connection open for 10 seconds
      setTimeout(() => {
        ws.close();
        console.log('   WebSocket closed after test');
      }, 10000);
    });
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        if (message.type === 'claude_status_update') {
          console.log(`📡 Status Update [${message.updateType}]:`, message.data);
        }
      } catch (e) {
        // Ignore non-JSON messages
      }
    });
    
    ws.on('error', (error) => {
      console.error('❌ WebSocket Error:', error.message);
    });
    
  } catch (error) {
    console.error('❌ WebSocket Test Error:', error.message);
  }
}

async function runTests() {
  console.log('🚀 Claude Code Status Integration Test\n');
  
  // Test status endpoints
  await testUIServerStatus();
  await testMCPServerStatus();
  
  // Test async job tracking
  await testAsyncJob();
  
  // Test WebSocket updates (runs in background)
  testWebSocketStatusUpdates();
  
  // Wait for WebSocket test to complete
  await new Promise(resolve => setTimeout(resolve, 12000));
  
  console.log('\n✅ All tests completed!');
}

// Run tests
runTests().catch(console.error);