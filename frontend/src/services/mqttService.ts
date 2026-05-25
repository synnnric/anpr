import mqtt, { type MqttClient, type IClientOptions } from 'mqtt';
import type { MqttConfig } from '../types/mqtt';

class MqttService {
  private client: MqttClient | null = null;
  private listeners: Map<string, Set<(topic: string, message: string) => void>> = new Map();
  private statusListeners: Set<(status: string) => void> = new Set();

  connect(config: MqttConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.client) {
        this.client.end(true);
      }

      const protocol = config.useSSL ? 'wss' : 'ws';
      const url = `${protocol}://${config.brokerUrl}:${config.port}/mqtt`;

      const options: IClientOptions = {
        clientId: config.clientId || `anpr_dashboard_${Date.now()}`,
        username: config.username || undefined,
        password: config.password || undefined,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
      };

      this.notifyStatus('connecting');

      this.client = mqtt.connect(url, options);

      this.client.on('connect', () => {
        this.notifyStatus('connected');
        resolve();
      });

      this.client.on('error', (err) => {
        this.notifyStatus('error');
        reject(err);
      });

      this.client.on('close', () => {
        this.notifyStatus('disconnected');
      });

      this.client.on('reconnect', () => {
        this.notifyStatus('connecting');
      });

      this.client.on('message', (topic: string, message: Buffer) => {
        const msg = message.toString();
        this.listeners.forEach((callbacks, pattern) => {
          if (this.topicMatches(pattern, topic)) {
            callbacks.forEach((cb) => cb(topic, msg));
          }
        });
      });

      setTimeout(() => {
        if (this.client && !this.client.connected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  disconnect(): void {
    if (this.client) {
      this.client.end(true);
      this.client = null;
      this.notifyStatus('disconnected');
    }
  }

  subscribe(topic: string, callback: (topic: string, message: string) => void): () => void {
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, new Set());
      if (this.client?.connected) {
        this.client.subscribe(topic);
      }
    }
    this.listeners.get(topic)!.add(callback);

    if (this.client?.connected) {
      this.client.subscribe(topic);
    }

    return () => {
      const callbacks = this.listeners.get(topic);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.listeners.delete(topic);
          if (this.client?.connected) {
            this.client.unsubscribe(topic);
          }
        }
      }
    };
  }

  publish(topic: string, message: string): void {
    if (this.client?.connected) {
      this.client.publish(topic, message);
    }
  }

  onStatusChange(callback: (status: string) => void): () => void {
    this.statusListeners.add(callback);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  private notifyStatus(status: string): void {
    this.statusListeners.forEach((cb) => cb(status));
  }

  private topicMatches(pattern: string, topic: string): boolean {
    if (pattern === topic) return true;
    if (pattern.includes('#') || pattern.includes('+')) {
      const patternParts = pattern.split('/');
      const topicParts = topic.split('/');

      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i] === '#') return true;
        if (patternParts[i] === '+') continue;
        if (patternParts[i] !== topicParts[i]) return false;
      }
      return patternParts.length === topicParts.length;
    }
    return false;
  }

  resubscribeAll(): void {
    if (this.client?.connected) {
      this.listeners.forEach((_callbacks, topic) => {
        this.client!.subscribe(topic);
      });
    }
  }
}

export const mqttService = new MqttService();
