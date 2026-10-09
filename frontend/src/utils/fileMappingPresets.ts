/**
 * File mapping presets (03-arquitetura §4), mirrored in
 * `api/graphlagoon/services/file_mapping_presets.py`. Each one equals the
 * `spec.json` of its golden fixture (simba-mini, qsa-mini); vitest and pytest
 * both check it.
 */
import type { MappingSpec } from '@/utils/fileMapping';
import type { FileEnrichmentSpec } from '@/types/investigation';

/**
 * SIMBA v3.1 (MI001-SPPEA): TAB, ddmmyyyy, cents; EXTRATO × ORIGEM_DESTINO are
 * the transactions, agency 9999 (NAO-CORRENTISTA) becomes one "Desconhecido"
 * node per transaction.
 */
export const SIMBA_V31: MappingSpec = {
  version: 1,
  name: 'SIMBA v3.1',
  inputs: {
    extrato: {
      match: '*_EXTRATO.TXT',
      delimiter: '\t',
      encoding: 'latin-1',
      header: true,
    },
    od: {
      match: '*_ORIGEM_DESTINO.TXT',
      delimiter: '\t',
      encoding: 'latin-1',
      header: true,
    },
    titulares: {
      match: '*_TITULARES.TXT',
      delimiter: '\t',
      encoding: 'latin-1',
      header: true,
    },
  },
  joins: [
    {
      left: 'extrato.CODIGO_CHAVE_EXTRATO',
      right: 'od.CODIGO_CHAVE_EXTRATO',
      as: 'lanc',
    },
  ],
  nodes: [
    {
      key: 'conta',
      type: 'Conta',
      from: 'lanc',
      id: {
        concat: ['extrato.NUMERO_BANCO', 'extrato.NUMERO_AGENCIA', 'extrato.NUMERO_CONTA'],
        normalize: 'account',
      },
      props: {
        banco: 'extrato.NUMERO_BANCO',
        agencia: 'extrato.NUMERO_AGENCIA',
        conta: 'extrato.NUMERO_CONTA',
      },
    },
    {
      key: 'pessoa',
      type: 'Pessoa',
      from: 'lanc',
      when: {
        ne: ['od.NUMERO_AGENCIA_OD', '9999'],
      },
      id: {
        col: 'od.CPF_CNPJ_OD',
        normalize: 'cpf_cnpj',
      },
      props: {
        nome: 'od.NOME_PESSOA_OD',
        cpf_cnpj: 'od.CPF_CNPJ_OD',
      },
    },
    {
      key: 'desconhecido',
      type: 'Desconhecido',
      from: 'lanc',
      when: {
        eq: ['od.NUMERO_AGENCIA_OD', '9999'],
      },
      id: {
        template: 'desconhecido:{od.CODIGO_CHAVE_OD}',
      },
      props: {
        observacao: 'od.OBSERVACAO',
      },
    },
    {
      key: 'conta_titular',
      type: 'Conta',
      from: 'titulares',
      id: {
        concat: ['titulares.NUMERO_BANCO', 'titulares.NUMERO_AGENCIA', 'titulares.NUMERO_CONTA'],
        normalize: 'account',
      },
    },
    {
      key: 'titular',
      type: 'Pessoa',
      from: 'titulares',
      id: {
        col: 'titulares.CPF_CNPJ_TITULAR',
        normalize: 'cpf_cnpj',
      },
      props: {
        nome: 'titulares.NOME_TITULAR',
        cpf_cnpj: 'titulares.CPF_CNPJ_TITULAR',
        renda: {
          col: 'titulares.VALOR_RENDA',
          convert: 'cents',
        },
      },
    },
  ],
  edges: [
    {
      from: 'lanc',
      id: {
        col: 'od.CODIGO_CHAVE_OD',
      },
      type: {
        col: 'extrato.TIPO_LANCAMENTO',
        map: 'simba_tipo_lancamento',
      },
      direction: {
        col: 'extrato.NATUREZA',
        C: 'in',
        D: 'out',
      },
      endpoints: {
        self: 'conta',
        other: ['pessoa', 'desconhecido'],
      },
      props: {
        valor: {
          col: 'od.VALOR_TRANSACAO',
          convert: 'cents',
        },
        data: {
          col: 'extrato.DATA_LANCAMENTO',
          convert: 'date:ddmmyyyy',
        },
        descricao: 'extrato.DESCRICAO',
      },
    },
    {
      from: 'titulares',
      type: 'TITULAR',
      endpoints: {
        self: 'titular',
        other: 'conta_titular',
      },
    },
  ],
  edge_semantics: {
    amount_prop: 'valor',
    time_prop: 'data',
    currency: 'BRL',
  },
  tables: {
    simba_tipo_lancamento: {
      '114': 'SAQUE',
      '120': 'TRANSF_INTERBANCARIA',
      '209': 'TRANSF_INTERBANCARIA',
      '220': 'DEPOSITO_ESPECIE',
      '222': 'RECEBIVEIS_CARTAO',
      '223': 'CREDITO_PIX_QR',
    },
  },
};

/**
 * Receita Federal open CNPJ data, "Sócios" file: ';', quoted, no header,
 * yyyymmdd; a natural-person partner's CPF comes masked, so it never becomes
 * an identity key.
 */
export const QSA_RECEITA: MappingSpec = {
  version: 1,
  name: 'QSA Receita',
  inputs: {
    qsa: {
      match: '*',
      delimiter: ';',
      encoding: 'latin-1',
      header: false,
      columns: [
        'CNPJ_BASICO',
        'IDENTIFICADOR_SOCIO',
        'NOME_SOCIO',
        'CNPJ_CPF_SOCIO',
        'QUALIFICACAO_SOCIO',
        'DATA_ENTRADA_SOCIEDADE',
        'PAIS',
        'REPRESENTANTE_LEGAL',
        'NOME_REPRESENTANTE',
        'QUALIFICACAO_REPRESENTANTE',
        'FAIXA_ETARIA',
      ],
    },
  },
  nodes: [
    {
      key: 'empresa',
      type: 'Empresa',
      from: 'qsa',
      id: {
        col: 'qsa.CNPJ_BASICO',
        convert: 'digits',
      },
      props: {
        cnpj_basico: 'qsa.CNPJ_BASICO',
      },
    },
    {
      key: 'socio_pj',
      type: 'Empresa',
      from: 'qsa',
      when: {
        eq: ['qsa.IDENTIFICADOR_SOCIO', '1'],
      },
      id: {
        col: 'qsa.CNPJ_CPF_SOCIO',
        normalize: 'cpf_cnpj',
      },
      props: {
        nome: 'qsa.NOME_SOCIO',
        cnpj: 'qsa.CNPJ_CPF_SOCIO',
      },
    },
    {
      key: 'socio_pf',
      type: 'Pessoa',
      from: 'qsa',
      when: {
        ne: ['qsa.IDENTIFICADOR_SOCIO', '1'],
      },
      id: {
        template: 'socio:{qsa.NOME_SOCIO}|{qsa.CNPJ_CPF_SOCIO}',
      },
      props: {
        nome: 'qsa.NOME_SOCIO',
        cpf_mascarado: 'qsa.CNPJ_CPF_SOCIO',
      },
    },
  ],
  edges: [
    {
      from: 'qsa',
      type: 'SOCIO_DE',
      direction: 'in',
      endpoints: {
        self: 'empresa',
        other: ['socio_pj', 'socio_pf'],
      },
      props: {
        qualificacao: {
          col: 'qsa.QUALIFICACAO_SOCIO',
          map: 'qsa_qualificacao',
        },
        desde: {
          col: 'qsa.DATA_ENTRADA_SOCIEDADE',
          convert: 'date:yyyymmdd',
        },
      },
    },
  ],
  tables: {
    qsa_qualificacao: {
      '22': 'Sócio',
      '49': 'Sócio-Administrador',
      '05': 'Administrador',
    },
  },
};

export const FILE_MAPPING_PRESETS: Record<string, MappingSpec> = {
  simba_v31: SIMBA_V31,
  qsa_receita: QSA_RECEITA,
};

/**
 * The QSA as an enrichment file (F2.6): the partners of a company, joined to the
 * case's merchants by CNPJ básico (the first 8 digits of the CNPJ).
 */
export const QSA_ENRICHMENT: FileEnrichmentSpec = {
  name: 'QSA Receita (sócios)',
  input: { delimiter: ';', header: false, columns: QSA_RECEITA.inputs.qsa.columns, encoding: 'latin-1' },
  key_column: 'CNPJ_BASICO',
  columns: ['NOME_SOCIO', 'CNPJ_CPF_SOCIO', 'QUALIFICACAO_SOCIO', 'DATA_ENTRADA_SOCIEDADE'],
  match_node_types: ['Lojista', 'Empresa'],
  match_source: { kind: 'prop', name: 'cnpj' },
  key_digits: 8,
};
