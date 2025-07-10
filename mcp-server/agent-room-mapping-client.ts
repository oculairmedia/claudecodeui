/**
 * Agent Room Mapping Client for Claude Code MCP
 * Communicates with the agent-room-mapping service to find Matrix rooms for agents
 */

interface AgentRoomMapping {
  agentId: string;
  roomId: string;
  isPrimary: boolean;
  addedAt: string;
}

export class AgentRoomMappingClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://192.168.50.90:3002') {
    this.baseUrl = baseUrl;
  }

  /**
   * Get the primary Matrix room for an agent
   */
  async getPrimaryRoom(agentId: string): Promise<string | null> {
    try {
      console.log(`[Agent Mapping] Fetching primary room for agent: ${agentId}`);
      
      const response = await fetch(`${this.baseUrl}/api/agent-room-mapping/${agentId}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          console.log(`[Agent Mapping] No room mapping found for agent: ${agentId}`);
          return null;
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.success && data.data && data.data.roomId) {
        console.log(`[Agent Mapping] Primary room for agent ${agentId}: ${data.data.roomId}`);
        return data.data.roomId;
      }
      
      console.log(`[Agent Mapping] No primary room found for agent: ${agentId}`);
      return null;
    } catch (error) {
      console.error(`[Agent Mapping] Error fetching primary room for agent ${agentId}:`, error);
      return null;
    }
  }

  /**
   * Get all room mappings for an agent
   */
  async getAllRooms(agentId: string): Promise<AgentRoomMapping[]> {
    try {
      console.log(`[Agent Mapping] Fetching all rooms for agent: ${agentId}`);
      
      const response = await fetch(`${this.baseUrl}/api/agent-room-mapping/${agentId}/all`);
      
      if (!response.ok) {
        if (response.status === 404) {
          console.log(`[Agent Mapping] No room mappings found for agent: ${agentId}`);
          return [];
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.success && data.mappings) {
        console.log(`[Agent Mapping] Found ${data.mappings.length} room mappings for agent ${agentId}`);
        return data.mappings;
      }
      
      console.log(`[Agent Mapping] No room mappings found for agent: ${agentId}`);
      return [];
    } catch (error) {
      console.error(`[Agent Mapping] Error fetching all rooms for agent ${agentId}:`, error);
      return [];
    }
  }

  /**
   * Check if the agent mapping service is available
   */
  async isServiceAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      return response.ok;
    } catch (error) {
      console.error(`[Agent Mapping] Service health check failed:`, error);
      return false;
    }
  }
}

/**
 * Factory function to create an agent room mapping client from environment variables
 */
export function createAgentRoomMappingClient(): AgentRoomMappingClient {
  const baseUrl = process.env.AGENT_ROOM_MAPPING_URL || 'http://192.168.50.90:3002';
  return new AgentRoomMappingClient(baseUrl);
}