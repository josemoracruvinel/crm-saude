/** Textos da cobrança da consulta pelo Asaas da clínica (migration 9222). */
export const TEXTOS_PAGAMENTO_DE_CONSULTA = {
  "Pagamento de consultas (Asaas)": { es: "Pago de consultas (Asaas)" },
  "Não conectada": { es: "No conectada" },
  "Ambiente de teste": { es: "Entorno de prueba" },
  "Produção": { es: "Producción" },
  "Aviso de pagamento não cadastrado": { es: "Aviso de pago no registrado" },
  "Com a conta conectada, o atendente de IA gera o link de pagamento da consulta e manda ao paciente. Quando o pagamento cai, a consulta se confirma sozinha. O dinheiro vai direto para a sua conta Asaas.": {
    es: "Con la cuenta conectada, el asistente de IA genera el enlace de pago de la consulta y lo envía al paciente. Cuando se acredita el pago, la consulta se confirma sola. El dinero va directo a su cuenta Asaas.",
  },
  "Não consegui ler a conexão com o Asaas.": { es: "No pude leer la conexión con Asaas." },
  "Trocar a chave de API do Asaas": { es: "Cambiar la clave de API de Asaas" },
  "Chave de API do Asaas": { es: "Clave de API de Asaas" },
  "No Asaas: Integrações › Chave de API. A chave do ambiente de teste começa com $aact_hmlg_ e não movimenta dinheiro de verdade. Também ligue a capacidade Cobrar a consulta no agente e preencha o preço do tipo de consulta.": {
    es: "En Asaas: Integraciones › Clave de API. La clave del entorno de prueba empieza con $aact_hmlg_ y no mueve dinero real. Active también la capacidad Cobrar la consulta en el agente y complete el precio del tipo de consulta.",
  },
  "Conectar": { es: "Conectar" },
  "Desconectar": { es: "Desconectar" },
  "Não consegui conectar o Asaas.": { es: "No pude conectar Asaas." },
  "Conta Asaas conectada.": { es: "Cuenta Asaas conectada." },
  "Não consegui desconectar o Asaas.": { es: "No pude desconectar Asaas." },
  "Conta Asaas desconectada.": { es: "Cuenta Asaas desconectada." },
  "Não consegui conectar.": { es: "No pude conectar." },
  "Essa não parece uma chave do Asaas: ela começa com $aact_prod_ ou $aact_hmlg_.": {
    es: "Esa no parece una clave de Asaas: empieza con $aact_prod_ o $aact_hmlg_.",
  },
  "O Asaas recusou a chave. Confira se copiou a chave inteira, começando por $aact_.": {
    es: "Asaas rechazó la clave. Verifique que copió la clave completa, empezando por $aact_.",
  },
  "A chave não tem permissão para criar cobranças. Gere uma chave nova no Asaas, em Integrações.": {
    es: "La clave no tiene permiso para crear cobros. Genere una clave nueva en Asaas, en Integraciones.",
  },
  "Não consegui falar com o Asaas agora. Tente de novo em instantes.": {
    es: "No pude comunicarme con Asaas ahora. Inténtelo de nuevo en unos instantes.",
  },
  "A cifra do servidor não está disponível; a chave não foi gravada.": {
    es: "El cifrado del servidor no está disponible; la clave no se guardó.",
  },
  "Este servidor não tem endereço https público, e o Asaas não consegue avisar os pagamentos.": {
    es: "Este servidor no tiene una dirección https pública, y Asaas no puede avisar los pagos.",
  },
  "A chave foi gravada, mas o Asaas recusou o cadastro do aviso de pagamento. Confira o e-mail da sua conta e tente conectar de novo.": {
    es: "La clave se guardó, pero Asaas rechazó el registro del aviso de pago. Verifique el correo de su cuenta e intente conectar de nuevo.",
  },
  "Não consegui gravar a conexão.": { es: "No pude guardar la conexión." },
  "Pagamento recebido! Sua consulta de {dia} às {hora} está confirmada. Até lá!": {
    es: "¡Pago recibido! Su consulta del {dia} a las {hora} está confirmada. ¡Hasta pronto!",
  },
  "Pagamento de consulta recebido sem horário reservado": { es: "Pago de consulta recibido sin horario reservado" },
  "O paciente pagou depois que a reserva do horário expirou ou foi cancelada. O dinheiro está na conta Asaas da clínica: remarque a consulta com ele ou faça o estorno pelo Asaas.": {
    es: "El paciente pagó después de que la reserva del horario venció o fue cancelada. El dinero está en la cuenta Asaas de la clínica: reprograme la consulta con él o haga el reembolso por Asaas.",
  },
} as const;
