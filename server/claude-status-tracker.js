/**
 * Claude Code Status Tracker
 * Tracks active jobs, sessions, and provides statistics
 */

class ClaudeStatusTracker {
  constructor() {
    this.activeJobs = new Map();
    this.completedJobs = [];
    this.stats = {
      totalJobsStarted: 0,
      totalJobsCompleted: 0,
      totalJobsFailed: 0,
      totalJobsAborted: 0,
      averageJobDuration: 0,
      sessionResumeCount: 0,
      checkpointHitCount: 0,
      startTime: new Date()
    };
    this.maxCompletedHistory = 100;
  }

  // Track a new job
  startJob(jobId, metadata = {}) {
    const job = {
      id: jobId,
      startTime: new Date(),
      status: 'running',
      ...metadata
    };
    
    this.activeJobs.set(jobId, job);
    this.stats.totalJobsStarted++;
    
    // Broadcast status update
    if (global.broadcastStatusUpdate) {
      global.broadcastStatusUpdate('job_started', {
        jobId,
        job,
        stats: this.getStats()
      });
    }
    
    return job;
  }

  // Update job progress
  updateJob(jobId, updates) {
    const job = this.activeJobs.get(jobId);
    if (job) {
      Object.assign(job, updates, { lastUpdate: new Date() });
      
      // Track checkpoint hits
      if (updates.checkpoint) {
        this.stats.checkpointHitCount++;
      }
      
      // Track session resumes
      if (updates.resumed) {
        this.stats.sessionResumeCount++;
      }
      
      // Broadcast status update
      if (global.broadcastStatusUpdate) {
        global.broadcastStatusUpdate('job_updated', {
          jobId,
          job,
          updates,
          stats: this.getStats()
        });
      }
    }
    return job;
  }

  // Complete a job
  completeJob(jobId, result = {}) {
    const job = this.activeJobs.get(jobId);
    if (job) {
      job.endTime = new Date();
      job.duration = job.endTime - job.startTime;
      job.status = result.error ? 'failed' : 'completed';
      job.result = result;
      
      // Update stats
      if (result.error) {
        this.stats.totalJobsFailed++;
      } else {
        this.stats.totalJobsCompleted++;
      }
      
      // Update average duration
      this.updateAverageDuration(job.duration);
      
      // Move to completed history
      this.completedJobs.unshift(job);
      if (this.completedJobs.length > this.maxCompletedHistory) {
        this.completedJobs.pop();
      }
      
      this.activeJobs.delete(jobId);
      
      // Broadcast status update
      if (global.broadcastStatusUpdate) {
        global.broadcastStatusUpdate('job_completed', {
          jobId,
          job,
          result,
          stats: this.getStats()
        });
      }
    }
    return job;
  }

  // Abort a job
  abortJob(jobId) {
    const job = this.activeJobs.get(jobId);
    if (job) {
      job.endTime = new Date();
      job.duration = job.endTime - job.startTime;
      job.status = 'aborted';
      
      this.stats.totalJobsAborted++;
      
      // Move to completed history
      this.completedJobs.unshift(job);
      if (this.completedJobs.length > this.maxCompletedHistory) {
        this.completedJobs.pop();
      }
      
      this.activeJobs.delete(jobId);
      
      // Broadcast status update
      if (global.broadcastStatusUpdate) {
        global.broadcastStatusUpdate('job_aborted', {
          jobId,
          job,
          stats: this.getStats()
        });
      }
    }
    return job;
  }

  // Get active jobs
  getActiveJobs() {
    return Array.from(this.activeJobs.values()).map(job => ({
      ...job,
      runningTime: new Date() - job.startTime
    }));
  }

  // Get completed jobs history
  getCompletedJobs(limit = 10) {
    return this.completedJobs.slice(0, limit);
  }

  // Get statistics
  getStats() {
    return {
      ...this.stats,
      uptime: new Date() - this.stats.startTime,
      activeJobCount: this.activeJobs.size,
      completedJobCount: this.completedJobs.length
    };
  }

  // Get job by ID (active or completed)
  getJob(jobId) {
    const activeJob = this.activeJobs.get(jobId);
    if (activeJob) return activeJob;
    
    return this.completedJobs.find(job => job.id === jobId);
  }

  // Update average duration calculation
  updateAverageDuration(duration) {
    const totalCompleted = this.stats.totalJobsCompleted + this.stats.totalJobsFailed;
    if (totalCompleted > 0) {
      this.stats.averageJobDuration = 
        (this.stats.averageJobDuration * (totalCompleted - 1) + duration) / totalCompleted;
    }
  }

  // Get status summary
  getSummary() {
    const activeJobs = this.getActiveJobs();
    const recentCompleted = this.getCompletedJobs(5);
    
    return {
      active: {
        count: activeJobs.length,
        jobs: activeJobs
      },
      recent: {
        count: recentCompleted.length,
        jobs: recentCompleted
      },
      stats: this.getStats()
    };
  }

  // Export metrics for monitoring
  exportMetrics() {
    const metrics = {
      claude_code_active_jobs: this.activeJobs.size,
      claude_code_total_started: this.stats.totalJobsStarted,
      claude_code_total_completed: this.stats.totalJobsCompleted,
      claude_code_total_failed: this.stats.totalJobsFailed,
      claude_code_total_aborted: this.stats.totalJobsAborted,
      claude_code_avg_duration_ms: Math.round(this.stats.averageJobDuration),
      claude_code_checkpoint_hits: this.stats.checkpointHitCount,
      claude_code_session_resumes: this.stats.sessionResumeCount,
      claude_code_uptime_seconds: Math.round((new Date() - this.stats.startTime) / 1000)
    };
    
    return metrics;
  }
}

// Create singleton instance
const claudeStatusTracker = new ClaudeStatusTracker();

module.exports = claudeStatusTracker;