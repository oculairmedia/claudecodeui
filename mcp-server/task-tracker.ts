export interface TaskInfo {
  taskId: string;
  agentId: string;
  createdAt: Date;
  prompt: string;
}

class TaskTracker {
  private activeTasks: Map<string, TaskInfo> = new Map();
  private taskTTL = 3600000; // 1 hour TTL

  constructor() {
    // Cleanup old tasks periodically
    setInterval(() => this.cleanupOldTasks(), 300000); // 5 minutes
  }

  createTask(taskId: string, agentId: string, prompt: string): void {
    const taskInfo: TaskInfo = {
      taskId,
      agentId,
      createdAt: new Date(),
      prompt: prompt.substring(0, 200) // Store first 200 chars for reference
    };

    this.activeTasks.set(taskId, taskInfo);
    console.error(`[TaskTracker] Created task ${taskId} for agent ${agentId}`);
  }

  getTask(taskId: string): TaskInfo | undefined {
    return this.activeTasks.get(taskId);
  }

  hasTask(taskId: string): boolean {
    return this.activeTasks.has(taskId);
  }

  removeTask(taskId: string): void {
    this.activeTasks.delete(taskId);
    console.error(`[TaskTracker] Removed task ${taskId}`);
  }

  private cleanupOldTasks(): void {
    const now = new Date().getTime();
    const toDelete: string[] = [];

    this.activeTasks.forEach((task, taskId) => {
      const age = now - task.createdAt.getTime();
      if (age > this.taskTTL) {
        toDelete.push(taskId);
      }
    });

    toDelete.forEach(taskId => {
      this.activeTasks.delete(taskId);
      console.error(`[TaskTracker] Cleaned up old task ${taskId}`);
    });
  }

  getStats(): Record<string, any> {
    return {
      activeTasks: this.activeTasks.size,
      tasks: Array.from(this.activeTasks.entries()).map(([id, task]) => ({
        taskId: id,
        agentId: task.agentId,
        age: Math.round((new Date().getTime() - task.createdAt.getTime()) / 1000) + 's'
      }))
    };
  }
}

export const taskTracker = new TaskTracker();