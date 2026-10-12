// Faixas e ocupações do cadastro da conta do estabelecimento. Os CÓDIGOS são os da documentação oficial da ValidaPay ("Subcontas: dados
// financeiros"): a operadora recebe o código, nunca o texto. Os rótulos são os da própria documentação.

export type Option = { value: string; label: string };

export const INCOME_OPTIONS: Option[] = [
  { value: 'DINP01', label: 'Até R$ 5.000' },
  { value: 'DINP02', label: 'R$ 5.001 a R$ 10.000' },
  { value: 'DINP03', label: 'R$ 10.001 a R$ 30.000' },
  { value: 'DINP04', label: 'R$ 30.001 a R$ 100.000' },
  { value: 'DINP05', label: 'Acima de R$ 100.000' },
];

export const NET_WORTH_OPTIONS: Option[] = [
  { value: 'NWNP01', label: 'Até R$ 50.000' },
  { value: 'NWNP02', label: 'R$ 50.001 a R$ 200.000' },
  { value: 'NWNP03', label: 'R$ 200.001 a R$ 1.000.000' },
  { value: 'NWNP04', label: 'R$ 1.000.001 a R$ 5.000.000' },
  { value: 'NWNP05', label: 'Acima de R$ 5.000.000' },
];

const OCCUPATIONS = [
  'Administrador / Gerente',
  'Vendedor / Representante Comercial',
  'Analista de RH / Assistente de Pessoal',
  'Analista Financeiro / Contador',
  'Desenvolvedor / Analista de Sistemas',
  'Profissional de Marketing / Publicitário',
  'Médico / Dentista / Enfermeiro',
  'Professor / Educador',
  'Engenheiro (em qualquer área)',
  'Advogado / Jurista',
  'Auxiliar de Serviços Gerais / Faxineiro',
  'Pedreiro / Servente / Mestre de Obras',
  'Motorista / Entregador / Logístico',
  'Recepcionista / Operador de Caixa',
  'Técnico em (Eletricidade, Mecânica, etc.)',
  'Designer Gráfico / Artista',
  'Operador de Máquinas / Montador',
  'Consultor / Autônomo (Prestador de Serviços)',
  'Cabeleireiro / Manicure / Esteticista',
  'Vigilante / Agente de Segurança',
  'Trabalhador Agropecuário / Agrônomo',
  'Agente de Viagens / Hoteleiro',
  'Jornalista / Relações Públicas',
  'Psicólogo / Terapeuta',
  'Servidor Público / Funcionário Federal/Estadual/Municipal',
  'Pesquisador / Cientista',
  'Artesão / Microempreendedor Individual (MEI)',
  'Aposentado / Reformado',
  'Estudante (Sem Renda Própria)',
  'Autônomo',
  'Outros',
];
export const OCCUPATION_OPTIONS: Option[] = OCCUPATIONS.map((label, i) => ({ value: `ONP${String(i + 1).padStart(2, '0')}`, label }));

export const OWNER_INCOME_OPTIONS: Option[] = INCOME_OPTIONS.map((o) => ({ value: o.value.replace('DINP', 'ODIB'), label: o.label }));

export const REVENUE_OPTIONS: Option[] = [
  { value: 'ODRB01', label: 'Até R$ 81.000 (MEI)' },
  { value: 'ODRB02', label: 'R$ 81.001 a R$ 360.000 (Microempresa)' },
  { value: 'ODRB03', label: 'R$ 360.001 a R$ 4.800.000 (EPP)' },
  { value: 'ODRB04', label: 'R$ 4.800.001 a R$ 78.000.000 (Média empresa)' },
  { value: 'ODRB05', label: 'Acima de R$ 78.000.000 (Grande empresa)' },
];

export const COMPANY_TYPE_OPTIONS: Option[] = [
  { value: 'PJ', label: 'Pessoa jurídica (PJ)' },
  { value: 'ME', label: 'Microempresa (ME)' },
  { value: 'MEI', label: 'Microempreendedor individual (MEI)' },
];
