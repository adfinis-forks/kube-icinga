import {Logger} from 'winston';
import {Icinga, IcingaObject} from '../icinga';
import Resource from './abstract.resource';
import {providerStream} from '../client/kube';

interface NodeOptions {
  discover: boolean;
  hostDefinition: object;
  hostTemplates: string[];
}

const DefaultOptions: NodeOptions = {
  discover: true,
  hostDefinition: {},
  hostTemplates: [],
};

/**
 * kubernetes hosts
 */
export default class Node extends Resource {
  protected icinga: Icinga;
  protected nodes: string[] = [];
  protected options = DefaultOptions;

  /**
   * kubernetes hosts
   */
  constructor(logger: Logger, icinga: Icinga, options: NodeOptions = DefaultOptions) {
    super(logger);
    this.icinga = icinga;
    this.options = Object.assign(this.options, options);
  }

  /**
   * Preapre icinga object and apply
   */
  public async prepareObject(definition: any): Promise<boolean> {
    let host: IcingaObject = {
      'display_name': definition.metadata.name,
      'address': definition.metadata.name,
      'vars._kubernetes': true,
      'vars.kubernetes': definition,
      'check_command': 'ping',
    };

    if (!definition.spec.unschedulable) {
      this.logger.debug('skip kube worker node '+definition.metadata.name+' since it is flagged as unschedulable');
      this.nodes.push(definition.metadata.name);
    }

    Object.assign(host, this.options.hostDefinition);
    return this.icinga.applyHost(definition.metadata.name, host, this.options.hostTemplates);
  }

  /**
   * Get collected nodes
   */
  public getWorkerNodes(): string[] {
    return this.nodes;
  }

  /**
   * Delete object
   */
  protected deleteObject(definition: any): Promise<boolean> {
    return this.icinga.deleteHost(definition.metadata.name);
  }

  /**
   * Start kube listener
   */
  public async kubeListener(provider: providerStream) {
    try {
      let stream = provider();
      stream.on('data', async (object: any) => {
        // ignore MODIFIER for kube nodes
        if (object.type === 'MODIFIED') {
          return false;
        }

        this.logger.debug('received kubernetes host resource', {object});
        return this.handleResource('Node', object, this.options);
      });

      stream.on('finish', () => {
        this.kubeListener(provider);
      });
    } catch (err) {
      this.logger.error('failed start nodes listener', {error: err});
    }
  }
}
