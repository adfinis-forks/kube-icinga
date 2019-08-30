import {Logger} from 'winston';
import {Icinga, IcingaObject} from '../icinga';
import KubeNode from './node';
import {default as AbstractResource} from './abstract.resource';
import {providerStream} from '../client/kube';
import {PersistentVolume} from 'kubernetes-types/core/v1';

interface VolumeOptions {
  discover: boolean;
  applyServices: boolean;
  attachToNodes: boolean;
  hostName: string;
  hostDefinition: object;
  serviceDefinition: object;
  serviceGroupDefinition: object;
  hostTemplates: string[];
  serviceTemplates: string[];
}

interface WatchEvent {
  type: string;
  object: PersistentVolume;
}

const DefaultOptions: VolumeOptions = {
  discover: true,
  applyServices: true,
  attachToNodes: false,
  hostName: 'kubernetes-volumes',
  hostDefinition: {},
  serviceDefinition: {},
  serviceGroupDefinition: {},
  hostTemplates: [],
  serviceTemplates: [],
};

/**
 * kubernetes ingresses
 */
export default class Volume extends AbstractResource {
  protected icinga: Icinga;
  protected kubeNode: KubeNode;
  protected options: VolumeOptions = DefaultOptions;

  /**
   * kubernetes hosts
   */
  constructor(logger: Logger, kubeNode: KubeNode, icinga: Icinga, options: any = DefaultOptions) {
    super(logger);
    this.logger = logger;
    this.icinga = icinga;
    this.kubeNode = kubeNode;
    this.options = Object.assign({}, this.options, options);
  }

  /**
   * Apply host
   */
  protected async applyHost(name: string, address: string, metadata: PersistentVolume, templates: string[]): Promise<boolean> {
    let definition: IcingaObject = {
      'display_name': name,
      'address': address,
      'check_command': 'dummy',
      'vars.dummy_state': 0,
      'vars._kubernetes': true,
      'vars.kubernetes': metadata,
    };

    Object.assign(definition, this.options.hostDefinition);
    return this.icinga.applyHost(name, definition, this.options.hostTemplates);
  }

  /**
   * Apply service
   */
  protected async applyService(host: string, name: string, definition: any, templates: string[]) {
    if (this.options.attachToNodes) {
      for (const node of this.kubeNode.getWorkerNodes()) {
        definition.host_name = node;
        this.icinga.applyService(node, name, definition, templates);
      }
    } else {
      definition.host_name = host;
      this.icinga.applyService(host, name, definition, templates);
    }
  }

  /**
   * Preapre icinga object and apply
   */
  public async prepareObject(definition: PersistentVolume): Promise<any> {
    let hostname = this.getHostname(definition);

    if (!this.options.attachToNodes) {
      await this.applyHost(hostname, hostname, definition, this.options.hostTemplates);
    }

    if (!definition.metadata || !definition.metadata.name) {
      throw new Error('resource name in metadata is required');
    }

    if (this.options.applyServices) {
      let groups = [];

      if (definition.spec!.claimRef!.namespace) {
        groups.push(definition.spec!.claimRef!.namespace);
        await this.icinga.applyServiceGroup(definition.spec!.claimRef!.namespace, Object.assign({'vars._kubernetes': true}, this.options.serviceGroupDefinition));
      }

      let templates = this.options.serviceTemplates;
      templates = templates.concat(this.prepareTemplates(definition));

      let service = this.options.serviceDefinition;
      let name = this.escapeName(definition.metadata.name);
      let addition = {
        'check_command': 'dummy',
        'display_name': `${definition.metadata.name}:volume`,
        'vars._kubernetes': true,
        'vars.kubernetes': definition,
        'groups': groups,
      };

      Object.assign(addition, service);
      Object.assign(addition, this.prepareResource(definition));
      this.applyService(hostname, name, addition, templates);
    }
  }

  /**
   * Get hostname
   */
  protected getHostname(definition: PersistentVolume): string {
    let annotations = this.getAnnotations(definition);

    if (annotations['kube-icinga/host']) {
      return annotations['kube-icinga/host'];
    } else if (this.options.hostName === null && definition.metadata && definition.metadata.name) {
      return this.escapeName(['volume', definition.metadata.name].join('-'));
    }

    return this.options.hostName;
  }

  /**
   * Delete object
   */
  protected deleteObject(definition: PersistentVolume): Promise<boolean> {
    if (this.options.hostName === null) {
      let hostname = this.getHostname(definition);
      return this.icinga.deleteHost(hostname);
    }

    return this.icinga.deleteServicesByFilter('service.vars.kubernetes.metadata.uid=="'+definition.metadata!.uid+'"');
  }

  /**
   * Start kube listener
   */
  public async kubeListener(provider: providerStream) {
    try {
      let stream = provider();
      stream.on('data', async (object: WatchEvent) => {
        this.logger.debug('received kubernetes persistent volume resource', {object});
        return this.handleResource('PersistentVolume', object, this.options);
      });

      stream.on('finish', () => {
        this.kubeListener(provider);
      });
    } catch (err) {
      this.logger.error('failed start ingresses listener', {error: err});
    }
  }
}
