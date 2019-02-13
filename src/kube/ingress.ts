import {Logger} from 'winston';
import Icinga from '../icinga';
import JSONStream from 'json-stream';
import KubeNode from './node';
import Resource from './abstract.resource';

interface IngressOptions {
  discover?: boolean;
  applyServices?: boolean;
  attachToNodes?: boolean;
  hostDefinition?: object;
  serviceDefinition?: object;
  hostTemplates?: string[];
  serviceTemplates?: string[];
}

/**
 * kubernetes ingresses
 */
export default class Ingress extends Resource {
  protected logger: Logger;
  protected icinga: Icinga;
  protected jsonStream: JSONStream;
  protected kubeNode: KubeNode;
  protected options = {
    applyServices: true,
    attachToNodes: false,
    hostDefinition: {},
    serviceDefinition: {},
    hostTemplates: [],
    serviceTemplates: [],
  };

  /**
   * kubernetes hosts
   */
  constructor(logger: Logger, kubeNode: KubeNode, icinga: Icinga, jsonStream: JSONStream, options: IngressOptions) {
    super();
    this.logger = logger;
    this.icinga = icinga;
    this.jsonStream = jsonStream;
    this.kubeNode = kubeNode;
    this.options = Object.assign(this.options, options);
  }  

  /**
   * Apply host
   */
  protected async applyHost(name: string, address: string, metadata, templates: string[]): Promise<boolean> {
    let definition = {
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
  protected async applyService(host: string, name: string, definition, templates: string[]) {
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
  public async prepareObject(definition: any): Promise<any> {
    let hostname = this.escapeName(['ingress', definition.metadata.namespace, definition.metadata.name].join('-'));
    if (!this.options.attachToNodes) {
      await this.applyHost(hostname, definition.metadata.name, definition, this.options.hostTemplates);
    }

    let service = this.prepareResource(definition);
    var templates = this.options.serviceTemplates;
    templates = templates.concat(this.prepareTemplates(definition));

    if (this.options.applyServices) {
      await this.icinga.applyServiceGroup(definition.metadata.namespace);

      for (const spec of definition.spec.rules) {
        for (const path of spec.http.paths) {
          let base = path.path || '/';
          let name = this.escapeName([spec.host, 'http', base].join('-'));   
          let addition = {
            'check_command': 'http',
            'display_name': `${spec.host}${base}:http`,
            'vars._kubernetes': true,
            'vars.kubernetes': definition,
            'vars.http_address': spec.host,
            'vars.http_vhost': spec.host,
            'vars.http_path': base,
            'vars.http_ignore_body': true,
            'groups': [definition.metadata.namespace],
          };

          Object.assign(addition, this.options.serviceDefinition);
          Object.assign(addition, service);
          this.applyService(hostname, name, addition, templates);

          // tls secret set, also apply https service
          if (definition.spec.tls) {
            name = this.escapeName([spec.host, 'https', base].join('-'));   
            addition.display_name += 's';
            addition['vars.http_ssl'] = true;
            this.applyService(hostname, name, addition, templates);
          }
        }
      }
    }
  }

  /**
   * Start kube listener
   */
  public async kubeListener(provider) {
    try {
      var stream = provider();
      stream.pipe(this.jsonStream);
      this.jsonStream.on('data', async (object) => {
        this.logger.debug('received kubernetes ingress resource', {object});

        if(object.object.kind !== 'Ingress') {
          this.logger.error('skip invalid ingress object', {object: object});
          return;
        }

        if (object.type == 'MODIFIED' || object.type == 'DELETED') {
          await this.icinga.deleteHost(object.object.metadata.name);
        }

        if (object.type == 'ADDED' || object.type == 'MODIFIED') {
          this.prepareObject(object.object).catch(err => {
            this.logger.error('failed to handle resource', {error: err})
          });
        }
      });

      this.jsonStream.on('finish', () => {
        this.kubeListener(provider);
      });
    } catch (err) {
      this.logger.error('failed start ingresses listener', {error: err});
    }
  }
}
