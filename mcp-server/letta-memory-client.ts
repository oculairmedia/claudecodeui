#!/usr/bin/env node
/**
 * Letta Memory Block Client for managing persistent agent memory
 */

import fetch from 'node-fetch';
import { debugLog } from './server.js';

interface LettaMemoryConfig {
  baseUrl: string;
  authToken: string;
  barePassword: string;
}

interface MemoryBlock {
  id?: string;
  label: string;
  value: string | object;
  description?: string;
  metadata?: Record<string, any>;
}

export interface TaskStatus {
  task_id: string;
  agent_id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  started_at: string;
  updated_at: string;
  completed_at?: string;
  estimated_completion?: string;
  progress: string;
  progress_percentage: number; // 0-100
  steps_completed: number;
  total_steps: number;
  current_step: string;
  step_details?: string; // Additional details about current step
  prompt: string;
  working_directory?: string;
  errors: TaskError[];
  warnings: TaskWarning[];
  result?: string;
  // Performance metrics
  execution_time_ms?: number;
  memory_usage_mb?: number;
  cpu_usage_percent?: number;
  // Task classification
  task_type?: 'file_operation' | 'code_generation' | 'analysis' | 'search' | 'git_operation' | 'terminal_command' | 'multi_step' | 'other';
  complexity_score?: number; // 1-10 scale
  // Output metadata
  files_created?: string[];
  files_modified?: string[];
  commands_executed?: string[];
  urls_accessed?: string[];
  // Interaction tracking
  user_interruptions?: number;
  clarifications_requested?: number;
  // Archival flags
  should_archive: boolean;
  archive_priority: 'low' | 'medium' | 'high';
  archive_tags?: string[];
}

export interface TaskError {
  timestamp: string;
  error_type: 'system' | 'user' | 'network' | 'permission' | 'timeout' | 'api' | 'validation';
  message: string;
  details?: string;
  stack_trace?: string;
  recoverable: boolean;
  recovery_attempted?: boolean;
}

export interface TaskWarning {
  timestamp: string;
  warning_type: 'performance' | 'security' | 'deprecation' | 'resource' | 'best_practice';
  message: string;
  details?: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ArchivalPassage {
  id?: string;
  text: string;
  created_at?: string;
  updated_at?: string;
  agent_id?: string;
  metadata?: Record<string, any>;
}

export class LettaMemoryClient {
  private config: LettaMemoryConfig;
  private taskBlockMap: Map<string, string> = new Map(); // Maps task_id to block_id

  constructor(config?: Partial<LettaMemoryConfig>) {
    this.config = {
      baseUrl: config?.baseUrl || process.env.LETTA_BASE_URL || 'https://letta.oculair.ca',
      authToken: config?.authToken || process.env.LETTA_AUTH_TOKEN || 'lettaSecurePass123',
      barePassword: config?.barePassword || process.env.LETTA_BARE_PASSWORD || 'password lettaSecurePass123'
    };
  }

  /**
   * List all memory blocks for an agent
   */
  async listMemoryBlocks(agentId: string): Promise<MemoryBlock[]> {
    const url = `${this.config.baseUrl}/v1/agents/${agentId}/core-memory/blocks`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json() as MemoryBlock[];
    } catch (error) {
      debugLog(`[Memory] Error listing blocks for agent ${agentId}:`, error);
      throw error;
    }
  }

  /**
   * Get a specific memory block by label
   */
  async getMemoryBlock(agentId: string, blockLabel: string): Promise<MemoryBlock | null> {
    const url = `${this.config.baseUrl}/v1/agents/${agentId}/core-memory/blocks/${blockLabel}`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json() as MemoryBlock;
    } catch (error) {
      debugLog(`[Memory] Error getting block ${blockLabel} for agent ${agentId}:`, error);
      throw error;
    }
  }

  /**
   * Update or create a memory block
   */
  async updateMemoryBlock(agentId: string, blockLabel: string, value: string | object): Promise<MemoryBlock> {
    const url = `${this.config.baseUrl}/v1/agents/${agentId}/core-memory/blocks/${blockLabel}`;
    
    const payload = {
      value: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    };

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: this.getHeaders(),
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }

      return await response.json() as MemoryBlock;
    } catch (error) {
      debugLog(`[Memory] Error updating block ${blockLabel} for agent ${agentId}:`, error);
      throw error;
    }
  }

  /**
   * Create a new memory block
   */
  async createMemoryBlock(blockData: {
    value: string | object;
    name: string;
    label: string;
    description?: string;
    metadata?: Record<string, any>;
    is_template?: boolean;
    preserve_on_migration?: boolean;
    read_only?: boolean;
  }): Promise<MemoryBlock> {
    const url = `${this.config.baseUrl}/v1/blocks/`;
    
    const payload = {
      ...blockData,
      value: typeof blockData.value === 'string' ? blockData.value : JSON.stringify(blockData.value, null, 2),
      limit: 5000,
      is_template: blockData.is_template || false,
      preserve_on_migration: blockData.preserve_on_migration || false,
      read_only: blockData.read_only || false
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }

      return await response.json() as MemoryBlock;
    } catch (error) {
      debugLog(`[Memory] Error creating block:`, error);
      throw error;
    }
  }

  /**
   * Update a memory block by ID
   */
  async updateBlockById(blockId: string, updateData: {
    value?: string | object;
    limit?: number;
    name?: string;
    is_template?: boolean;
    preserve_on_migration?: boolean;
    label?: string;
    read_only?: boolean;
    description?: string;
    metadata?: Record<string, any>;
  }): Promise<MemoryBlock> {
    const url = `${this.config.baseUrl}/v1/blocks/${blockId}`;
    
    const payload = {
      ...updateData,
      value: updateData.value ? 
        (typeof updateData.value === 'string' ? updateData.value : JSON.stringify(updateData.value, null, 2)) :
        undefined
    };

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: this.getHeaders(),
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }

      return await response.json() as MemoryBlock;
    } catch (error) {
      debugLog(`[Memory] Error updating block ${blockId}:`, error);
      throw error;
    }
  }

  /**
   * Update Claude Code task status
   */
  async updateTaskStatus(agentId: string, status: TaskStatus): Promise<void> {
    try {
      const blockName = `claude_task_${status.task_id}`;
      const timestamp = new Date().toISOString();
      const existingBlockId = this.taskBlockMap.get(status.task_id);
      
      if (existingBlockId) {
        // Update existing block
        await this.updateBlockById(existingBlockId, {
          value: status,
          description: `Claude Code task ${status.task_id} - ${status.status} at ${timestamp}`,
          metadata: {
            task_id: status.task_id,
            agent_id: agentId,
            status: status.status,
            created_at: status.started_at,
            updated_at: timestamp,
            prompt: status.prompt
          }
        });
        debugLog(`[Memory] Updated block ${existingBlockId} for task ${status.task_id}, status: ${status.status}`);
      } else {
        // Create new block for first time
        const block = await this.createMemoryBlock({
          value: status,
          name: blockName,
          label: blockName,
          description: `Claude Code task ${status.task_id} - ${status.status} at ${timestamp}`,
          metadata: {
            task_id: status.task_id,
            agent_id: agentId,
            status: status.status,
            created_at: timestamp,
            updated_at: timestamp,
            prompt: status.prompt
          }
        });
        
        debugLog(`[Memory] Created memory block ${block.id} for task ${status.task_id}, status: ${status.status}`);
        
        // Store the block ID for future updates
        if (block.id) {
          this.taskBlockMap.set(status.task_id, block.id);
          
          // Attach the block to the agent
          await this.attachBlockToAgent(agentId, block.id);
          debugLog(`[Memory] Attached block ${block.id} to agent ${agentId}`);
        }
      }
      
      // Clean up old task blocks periodically (only on completed/failed status)
      if (status.status === 'completed' || status.status === 'failed') {
        const keepCount = (status as any).keepTaskBlocks || 3;
        await this.cleanupOldTaskBlocks(agentId, keepCount);
      }
    } catch (error) {
      debugLog(`[Memory] Error updating task status block:`, error);
      // Don't throw - we don't want memory errors to break task execution
    }
  }
  
  /**
   * Clean up old task blocks, keeping only the most recent ones
   */
  async cleanupOldTaskBlocks(agentId: string, keepCount: number = 3): Promise<void> {
    try {
      const blocks = await this.listMemoryBlocks(agentId);
      
      // Filter for claude_task_ blocks that are NOT elevated
      const taskBlocks = blocks.filter(b => 
        b.label?.startsWith('claude_task_') && 
        !b.metadata?.elevated // Skip elevated blocks
      );
      
      // Sort by creation time (from metadata)
      taskBlocks.sort((a, b) => {
        const timeA = a.metadata?.created_at || '';
        const timeB = b.metadata?.created_at || '';
        return timeB.localeCompare(timeA); // Newest first
      });
      
      // Detach old blocks
      const blocksToRemove = taskBlocks.slice(keepCount);
      for (const block of blocksToRemove) {
        if (block.id) {
          await this.detachBlockFromAgent(agentId, block.id);
          debugLog(`[Memory] Cleaned up old task block ${block.id}`);
        }
      }
      
      // Log elevated blocks count
      const elevatedCount = blocks.filter(b => 
        b.label?.startsWith('claude_task_') && 
        b.metadata?.elevated
      ).length;
      if (elevatedCount > 0) {
        debugLog(`[Memory] Keeping ${elevatedCount} elevated task blocks`);
      }
    } catch (error) {
      debugLog(`[Memory] Error cleaning up old task blocks:`, error);
      // Don't throw - cleanup errors shouldn't break the main flow
    }
  }

  /**
   * Attach a block to an agent
   */
  async attachBlockToAgent(agentId: string, blockId: string): Promise<void> {
    const url = `${this.config.baseUrl}/v1/agents/${agentId}/core-memory/blocks/attach/${blockId}`;
    
    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }
      
      debugLog(`[Memory] Successfully attached block ${blockId} to agent ${agentId}`);
    } catch (error) {
      debugLog(`[Memory] Error attaching block to agent:`, error);
      throw error;
    }
  }

  /**
   * Detach a block from an agent
   */
  async detachBlockFromAgent(agentId: string, blockId: string): Promise<void> {
    const url = `${this.config.baseUrl}/v1/agents/${agentId}/core-memory/blocks/detach/${blockId}`;
    
    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }
      
      debugLog(`[Memory] Successfully detached block ${blockId} from agent ${agentId}`);
    } catch (error) {
      debugLog(`[Memory] Error detaching block from agent:`, error);
      throw error;
    }
  }

  /**
   * Add task to history
   */
  private async addToTaskHistory(agentId: string, status: TaskStatus): Promise<void> {
    try {
      // Get existing history
      const historyBlock = await this.getMemoryBlock(agentId, 'claude_mcp_task_history');
      let history: TaskStatus[] = [];
      
      if (historyBlock && historyBlock.value) {
        try {
          const value = typeof historyBlock.value === 'string' 
            ? JSON.parse(historyBlock.value) 
            : historyBlock.value;
          history = Array.isArray(value) ? value : [];
        } catch (e) {
          history = [];
        }
      }
      
      // Add new task to history (keep last 10)
      history.unshift(status);
      history = history.slice(0, 10);
      
      // Update history block
      await this.updateMemoryBlock(agentId, 'claude_mcp_task_history', history);
    } catch (error) {
      debugLog(`[Memory] Error updating task history:`, error);
    }
  }

  /**
   * Log an error to the error block
   */
  async logError(agentId: string, taskId: string, error: string): Promise<void> {
    try {
      const errorEntry = {
        task_id: taskId,
        timestamp: new Date().toISOString(),
        error: error
      };
      
      // Get existing errors
      const errorBlock = await this.getMemoryBlock(agentId, 'claude_mcp_task_errors');
      let errors: any[] = [];
      
      if (errorBlock && errorBlock.value) {
        try {
          const value = typeof errorBlock.value === 'string' 
            ? JSON.parse(errorBlock.value) 
            : errorBlock.value;
          errors = Array.isArray(value) ? value : [];
        } catch (e) {
          errors = [];
        }
      }
      
      // Add new error (keep last 20)
      errors.unshift(errorEntry);
      errors = errors.slice(0, 20);
      
      // Update error block
      await this.updateMemoryBlock(agentId, 'claude_mcp_task_errors', errors);
    } catch (error) {
      debugLog(`[Memory] Error logging error:`, error);
    }
  }

  /**
   * Add an error to a task's error log
   */
  async addTaskError(agentId: string, taskId: string, error: TaskError): Promise<void> {
    try {
      const blockId = this.taskBlockMap.get(taskId);
      if (!blockId) {
        debugLog(`[Memory] No block found for task ${taskId}, cannot add error`);
        return;
      }

      // Get current task status
      const blockData = await this.updateBlockById(blockId, {});
      if (!blockData.value) return;

      const taskStatus = typeof blockData.value === 'string' 
        ? JSON.parse(blockData.value) 
        : blockData.value;

      // Add error to the task
      if (!taskStatus.errors) taskStatus.errors = [];
      taskStatus.errors.push(error);
      taskStatus.updated_at = new Date().toISOString();

      // Update the block
      await this.updateBlockById(blockId, {
        value: taskStatus,
        metadata: {
          ...blockData.metadata,
          error_count: taskStatus.errors.length,
          last_error: error.timestamp
        }
      });

      debugLog(`[Memory] Added error to task ${taskId}`);
    } catch (error) {
      debugLog(`[Memory] Error adding task error:`, error);
    }
  }

  /**
   * Add a warning to a task's warning log
   */
  async addTaskWarning(agentId: string, taskId: string, warning: TaskWarning): Promise<void> {
    try {
      const blockId = this.taskBlockMap.get(taskId);
      if (!blockId) {
        debugLog(`[Memory] No block found for task ${taskId}, cannot add warning`);
        return;
      }

      // Get current task status
      const blockData = await this.updateBlockById(blockId, {});
      if (!blockData.value) return;

      const taskStatus = typeof blockData.value === 'string' 
        ? JSON.parse(blockData.value) 
        : blockData.value;

      // Add warning to the task
      if (!taskStatus.warnings) taskStatus.warnings = [];
      taskStatus.warnings.push(warning);
      taskStatus.updated_at = new Date().toISOString();

      // Update the block
      await this.updateBlockById(blockId, {
        value: taskStatus,
        metadata: {
          ...blockData.metadata,
          warning_count: taskStatus.warnings.length,
          last_warning: warning.timestamp
        }
      });

      debugLog(`[Memory] Added warning to task ${taskId}`);
    } catch (error) {
      debugLog(`[Memory] Error adding task warning:`, error);
    }
  }

  /**
   * Update task progress with detailed tracking
   */
  async updateTaskProgress(
    agentId: string, 
    taskId: string, 
    updates: Partial<Pick<TaskStatus, 
      'progress' | 'progress_percentage' | 'current_step' | 'step_details' | 
      'steps_completed' | 'total_steps' | 'execution_time_ms' | 'memory_usage_mb' | 
      'cpu_usage_percent' | 'files_created' | 'files_modified' | 'commands_executed' | 
      'urls_accessed' | 'user_interruptions' | 'clarifications_requested'
    >>
  ): Promise<void> {
    try {
      const blockId = this.taskBlockMap.get(taskId);
      if (!blockId) {
        debugLog(`[Memory] No block found for task ${taskId}, cannot update progress`);
        return;
      }

      // Get current task status
      const blockData = await this.updateBlockById(blockId, {});
      if (!blockData.value) return;

      const taskStatus = typeof blockData.value === 'string' 
        ? JSON.parse(blockData.value) 
        : blockData.value;

      // Apply updates
      Object.assign(taskStatus, updates);
      taskStatus.updated_at = new Date().toISOString();

      // Calculate execution time if not provided
      if (!updates.execution_time_ms && taskStatus.started_at) {
        const startTime = new Date(taskStatus.started_at);
        taskStatus.execution_time_ms = Date.now() - startTime.getTime();
      }

      // Update the block
      await this.updateBlockById(blockId, {
        value: taskStatus,
        metadata: {
          ...blockData.metadata,
          progress_percentage: updates.progress_percentage || taskStatus.progress_percentage,
          current_step: updates.current_step || taskStatus.current_step,
          last_update: new Date().toISOString()
        }
      });

      debugLog(`[Memory] Updated progress for task ${taskId}: ${updates.progress_percentage || taskStatus.progress_percentage}%`);
    } catch (error) {
      debugLog(`[Memory] Error updating task progress:`, error);
    }
  }

  /**
   * Classify task type based on prompt content
   */
  classifyTask(prompt: string): { 
    task_type: TaskStatus['task_type'], 
    complexity_score: number,
    should_archive: boolean,
    archive_priority: TaskStatus['archive_priority'],
    archive_tags: string[]
  } {
    const lowerPrompt = prompt.toLowerCase();
    let task_type: TaskStatus['task_type'] = 'other';
    let complexity_score = 1;
    let archive_tags: string[] = [];

    // Classify task type
    if (lowerPrompt.includes('file') || lowerPrompt.includes('create') || lowerPrompt.includes('write') || lowerPrompt.includes('edit')) {
      task_type = 'file_operation';
      archive_tags.push('file-ops');
    } else if (lowerPrompt.includes('generate') || lowerPrompt.includes('code') || lowerPrompt.includes('script')) {
      task_type = 'code_generation';
      archive_tags.push('code-gen');
    } else if (lowerPrompt.includes('analyze') || lowerPrompt.includes('review') || lowerPrompt.includes('examine')) {
      task_type = 'analysis';
      archive_tags.push('analysis');
    } else if (lowerPrompt.includes('search') || lowerPrompt.includes('find') || lowerPrompt.includes('research')) {
      task_type = 'search';
      archive_tags.push('search');
    } else if (lowerPrompt.includes('git') || lowerPrompt.includes('commit') || lowerPrompt.includes('push') || lowerPrompt.includes('branch')) {
      task_type = 'git_operation';
      archive_tags.push('git');
    } else if (lowerPrompt.includes('run') || lowerPrompt.includes('execute') || lowerPrompt.includes('command')) {
      task_type = 'terminal_command';
      archive_tags.push('terminal');
    }

    // Calculate complexity score (1-10)
    complexity_score = Math.min(10, Math.max(1, Math.floor(prompt.length / 100) + 1));

    // Multi-step detection
    const stepIndicators = ['then', 'after', 'next', 'finally', 'also', 'and'];
    const hasMultipleSteps = stepIndicators.some(indicator => lowerPrompt.includes(indicator));
    if (hasMultipleSteps) {
      task_type = 'multi_step';
      complexity_score = Math.min(10, complexity_score + 2);
      archive_tags.push('multi-step');
    }

    // Determine archival priority
    let archive_priority: TaskStatus['archive_priority'] = 'low';
    let should_archive = false;

    if (complexity_score >= 7 || task_type === 'multi_step') {
      archive_priority = 'high';
      should_archive = true;
    } else if (complexity_score >= 4 || ['code_generation', 'analysis', 'git_operation'].includes(task_type)) {
      archive_priority = 'medium';
      should_archive = true;
    } else if (['file_operation', 'search'].includes(task_type)) {
      should_archive = true;
    }

    return {
      task_type,
      complexity_score,
      should_archive,
      archive_priority,
      archive_tags
    };
  }

  /**
   * Create enhanced task status with automatic classification
   */
  createEnhancedTaskStatus(
    taskId: string, 
    agentId: string, 
    prompt: string, 
    workingDirectory?: string
  ): TaskStatus {
    const now = new Date();
    const classification = this.classifyTask(prompt);
    
    return {
      task_id: taskId,
      agent_id: agentId,
      status: 'pending',
      started_at: now.toISOString(),
      updated_at: now.toISOString(),
      estimated_completion: this.calculateEstimatedCompletion(prompt, now).toISOString(),
      progress: 'Task received and queued',
      progress_percentage: 0,
      steps_completed: 0,
      total_steps: 1,
      current_step: 'Starting Claude Code',
      prompt: prompt,
      working_directory: workingDirectory,
      errors: [],
      warnings: [],
      user_interruptions: 0,
      clarifications_requested: 0,
      files_created: [],
      files_modified: [],
      commands_executed: [],
      urls_accessed: [],
      ...classification
    };
  }

  /**
   * Complete a task with final metrics and archival
   */
  async completeTask(
    agentId: string, 
    taskId: string, 
    result: string, 
    success: boolean = true,
    finalMetrics?: {
      execution_time_ms?: number;
      memory_usage_mb?: number;
      cpu_usage_percent?: number;
      files_created?: string[];
      files_modified?: string[];
      commands_executed?: string[];
      urls_accessed?: string[];
    }
  ): Promise<void> {
    try {
      const blockId = this.taskBlockMap.get(taskId);
      if (!blockId) {
        debugLog(`[Memory] No block found for task ${taskId}, cannot complete`);
        return;
      }

      // Get current task status
      const blockData = await this.updateBlockById(blockId, {});
      if (!blockData.value) return;

      const taskStatus = typeof blockData.value === 'string' 
        ? JSON.parse(blockData.value) 
        : blockData.value;

      // Update final status
      taskStatus.status = success ? 'completed' : 'failed';
      taskStatus.completed_at = new Date().toISOString();
      taskStatus.updated_at = new Date().toISOString();
      taskStatus.result = result;
      taskStatus.progress = success ? 'Task completed successfully' : 'Task failed';
      taskStatus.progress_percentage = success ? 100 : taskStatus.progress_percentage;
      taskStatus.current_step = success ? 'Completed' : 'Failed';
      taskStatus.steps_completed = success ? taskStatus.total_steps : taskStatus.steps_completed;

      // Apply final metrics
      if (finalMetrics) {
        Object.assign(taskStatus, finalMetrics);
      }

      // Calculate execution time if not provided
      if (!taskStatus.execution_time_ms && taskStatus.started_at) {
        const startTime = new Date(taskStatus.started_at);
        taskStatus.execution_time_ms = Date.now() - startTime.getTime();
      }

      // Update the block
      await this.updateBlockById(blockId, {
        value: taskStatus,
        metadata: {
          ...blockData.metadata,
          completed: true,
          success: success,
          execution_time_ms: taskStatus.execution_time_ms,
          completion_timestamp: taskStatus.completed_at
        }
      });

      // Archive to long-term memory if needed
      if (taskStatus.should_archive) {
        await this.archiveTaskToLongTermMemory(agentId, taskStatus);
      }

      // Delete the temporary task memory block
      await this.deleteTaskMemoryBlock(agentId, taskId);

      debugLog(`[Memory] Completed task ${taskId} with status: ${taskStatus.status}`);
    } catch (error) {
      debugLog(`[Memory] Error completing task:`, error);
    }
  }

  /**
   * Archive task to Letta's long-term archival memory
   */
  private async archiveTaskToLongTermMemory(agentId: string, taskStatus: TaskStatus): Promise<void> {
    try {
      // Format task data for archival
      const archivalText = this.formatTaskForArchival(taskStatus);
      
      // Create metadata for the passage
      const metadata = {
        task_id: taskStatus.task_id,
        task_type: taskStatus.task_type,
        complexity_score: taskStatus.complexity_score,
        archive_priority: taskStatus.archive_priority,
        status: taskStatus.status,
        execution_time_ms: taskStatus.execution_time_ms,
        timestamp: taskStatus.completed_at || taskStatus.updated_at,
        tags: taskStatus.archive_tags || []
      };

      // Create archival passage
      const passage = await this.createArchivalPassage(agentId, archivalText, metadata);
      
      debugLog(`[Memory] Archived task ${taskStatus.task_id} to long-term memory with passage ID: ${passage.id}`);
    } catch (error) {
      debugLog(`[Memory] Error archiving task to long-term memory:`, error);
      // Don't throw - archival failure shouldn't block task completion
    }
  }

  /**
   * Delete task memory block and clean up
   */
  private async deleteTaskMemoryBlock(agentId: string, taskId: string): Promise<void> {
    try {
      const blockId = this.taskBlockMap.get(taskId);
      if (!blockId) {
        debugLog(`[Memory] No block found for task ${taskId}, nothing to delete`);
        return;
      }

      // Delete the memory block
      await this.deleteMemoryBlock(blockId);
      
      // Remove from task block mapping
      this.taskBlockMap.delete(taskId);
      
      debugLog(`[Memory] Deleted task memory block ${blockId} for task ${taskId}`);
    } catch (error) {
      debugLog(`[Memory] Error deleting task memory block:`, error);
      // Don't throw - deletion failure shouldn't block task completion
    }
  }

  /**
   * Archive completed task to persistent storage (DEPRECATED - replaced by archival memory)
   */
  private async archiveCompletedTask(agentId: string, taskStatus: TaskStatus): Promise<void> {
    try {
      // Get or create archive block
      let archiveBlock = await this.getMemoryBlock(agentId, 'claude_mcp_task_archive');
      let archivedTasks: TaskStatus[] = [];
      
      if (archiveBlock && archiveBlock.value) {
        try {
          const value = typeof archiveBlock.value === 'string' 
            ? JSON.parse(archiveBlock.value) 
            : archiveBlock.value;
          archivedTasks = Array.isArray(value) ? value : [];
        } catch (e) {
          archivedTasks = [];
        }
      }
      
      // Add task to archive (keep last 50 by priority)
      archivedTasks.unshift(taskStatus);
      
      // Sort by priority and keep top entries
      archivedTasks.sort((a, b) => {
        const priorityOrder = { high: 3, medium: 2, low: 1 };
        return priorityOrder[b.archive_priority] - priorityOrder[a.archive_priority];
      });
      archivedTasks = archivedTasks.slice(0, 50);
      
      // Update archive block
      await this.updateMemoryBlock(agentId, 'claude_mcp_task_archive', archivedTasks);
      
      debugLog(`[Memory] Archived task ${taskStatus.task_id} with priority ${taskStatus.archive_priority}`);
    } catch (error) {
      debugLog(`[Memory] Error archiving task:`, error);
    }
  }

  /**
   * Calculate estimated completion time based on task type
   */
  calculateEstimatedCompletion(prompt: string, startTime: Date): Date {
    const now = startTime || new Date();
    let estimatedMinutes = 2; // Default 2 minutes
    
    // Estimate based on task complexity
    if (prompt.toLowerCase().includes('search') || prompt.toLowerCase().includes('research')) {
      estimatedMinutes = 3;
    }
    if (prompt.toLowerCase().includes('analyze') || prompt.toLowerCase().includes('summarize')) {
      estimatedMinutes = 4;
    }
    if (prompt.toLowerCase().includes('create') || prompt.toLowerCase().includes('generate')) {
      estimatedMinutes = 5;
    }
    if (prompt.length > 500) {
      estimatedMinutes += 2; // Complex prompts take longer
    }
    
    const estimated = new Date(now.getTime() + estimatedMinutes * 60 * 1000);
    return estimated;
  }

  /**
   * Create archival memory passage for long-term storage
   */
  async createArchivalPassage(agentId: string, text: string, metadata?: Record<string, any>): Promise<ArchivalPassage> {
    const url = `${this.config.baseUrl}/v1/agents/${agentId}/archival-memory`;
    
    const payload = {
      text: text,
      ...(metadata && { metadata })
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }

      const result = await response.json();
      return Array.isArray(result) && result.length > 0 ? result[0] as ArchivalPassage : result as ArchivalPassage;
    } catch (error) {
      debugLog(`[Memory] Error creating archival passage:`, error);
      throw error;
    }
  }

  /**
   * Delete a memory block by ID
   */
  async deleteMemoryBlock(blockId: string): Promise<void> {
    const url = `${this.config.baseUrl}/v1/blocks/${blockId}`;
    
    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }

      debugLog(`[Memory] Successfully deleted memory block ${blockId}`);
    } catch (error) {
      debugLog(`[Memory] Error deleting memory block ${blockId}:`, error);
      throw error;
    }
  }

  /**
   * Format task data for archival memory passage
   */
  formatTaskForArchival(taskStatus: TaskStatus): string {
    const sections = [];

    // Header with task info
    sections.push(`# Claude Code Task: ${taskStatus.task_id}`);
    sections.push(`**Status:** ${taskStatus.status}`);
    sections.push(`**Type:** ${taskStatus.task_type || 'other'}`);
    sections.push(`**Complexity:** ${taskStatus.complexity_score || 1}/10`);
    sections.push(`**Started:** ${taskStatus.started_at}`);
    if (taskStatus.completed_at) {
      sections.push(`**Completed:** ${taskStatus.completed_at}`);
    }
    if (taskStatus.execution_time_ms) {
      sections.push(`**Duration:** ${Math.round(taskStatus.execution_time_ms / 1000)}s`);
    }
    sections.push('');

    // Original prompt
    sections.push('## Original Request');
    sections.push(taskStatus.prompt);
    sections.push('');

    // Progress and steps
    if (taskStatus.total_steps > 0) {
      sections.push('## Progress');
      sections.push(`Completed ${taskStatus.steps_completed}/${taskStatus.total_steps} steps (${taskStatus.progress_percentage}%)`);
      if (taskStatus.current_step) {
        sections.push(`Final step: ${taskStatus.current_step}`);
      }
      sections.push('');
    }

    // Results
    if (taskStatus.result) {
      sections.push('## Result');
      sections.push(taskStatus.result);
      sections.push('');
    }

    // Files and outputs
    if (taskStatus.files_created?.length || taskStatus.files_modified?.length || taskStatus.commands_executed?.length) {
      sections.push('## Outputs');
      
      if (taskStatus.files_created?.length) {
        sections.push('**Files Created:**');
        taskStatus.files_created.forEach(file => sections.push(`- ${file}`));
      }
      
      if (taskStatus.files_modified?.length) {
        sections.push('**Files Modified:**');
        taskStatus.files_modified.forEach(file => sections.push(`- ${file}`));
      }
      
      if (taskStatus.commands_executed?.length) {
        sections.push('**Commands Executed:**');
        taskStatus.commands_executed.forEach(cmd => sections.push(`- ${cmd}`));
      }
      sections.push('');
    }

    // Performance metrics
    if (taskStatus.memory_usage_mb || taskStatus.cpu_usage_percent) {
      sections.push('## Performance');
      if (taskStatus.memory_usage_mb) {
        sections.push(`Memory: ${taskStatus.memory_usage_mb}MB`);
      }
      if (taskStatus.cpu_usage_percent) {
        sections.push(`CPU: ${taskStatus.cpu_usage_percent}%`);
      }
      sections.push('');
    }

    // Errors and warnings
    if (taskStatus.errors?.length || taskStatus.warnings?.length) {
      sections.push('## Issues');
      
      if (taskStatus.errors?.length) {
        sections.push('**Errors:**');
        taskStatus.errors.forEach(error => {
          sections.push(`- [${error.error_type}] ${error.message}`);
          if (error.details) sections.push(`  Details: ${error.details}`);
        });
      }
      
      if (taskStatus.warnings?.length) {
        sections.push('**Warnings:**');
        taskStatus.warnings.forEach(warning => {
          sections.push(`- [${warning.warning_type}] ${warning.message}`);
        });
      }
      sections.push('');
    }

    // Tags for searchability
    const tags = [];
    if (taskStatus.task_type) tags.push(taskStatus.task_type);
    if (taskStatus.archive_tags?.length) tags.push(...taskStatus.archive_tags);
    if (taskStatus.status === 'completed') tags.push('completed');
    if (taskStatus.status === 'failed') tags.push('failed');
    if (taskStatus.complexity_score && taskStatus.complexity_score >= 7) tags.push('complex');

    if (tags.length > 0) {
      sections.push(`## Tags: ${tags.join(', ')}`);
    }

    return sections.join('\n');
  }

  /**
   * Get headers for API requests
   */
  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.authToken}`,
      'X-BARE-PASSWORD': this.config.barePassword,
      'Content-Type': 'application/json'
    };
  }
}

// Export singleton instance for convenience
export const memoryClient = new LettaMemoryClient();