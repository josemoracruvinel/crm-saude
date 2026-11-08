<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/marca/fluxo-care-logo-escuro.png">
    <img src="docs/marca/fluxo-care-logo-claro.png" alt="Fluxo Care" width="420">
  </picture>
</p>

# Fluxo Care

Sistema de gestão para médicos e clínicas: atendimento por WhatsApp com agentes de IA, CRM, agenda e
funil comercial em um só lugar. Mantido pela [Fluxo Auditoria](https://www.fluxoauditoria.com.br).

## O que faz hoje

- **Atendimento:** caixa de entrada única do WhatsApp, com atendentes humanos e agentes de IA que
  respondem, qualificam e encaminham.
- **CRM e funil:** contatos, funis por etapa, tarefas, follow-ups e campanhas.
- **Agenda:** agendamento integrado ao atendimento (com Google Agenda).
- **LGPD:** isolamento por organização, trilha de auditoria, anonimização e pedidos de titular.
- **Multiempresa:** uma instalação atende várias clínicas, cada uma com seus dados isolados.

Em desenvolvimento: prontuário eletrônico, prescrição digital (Memed) e teleconsulta (Jitsi próprio).

## Versões e atualização

- As versões publicadas ficam em [Releases](../../releases); o que muda em cada uma está no
  [CHANGELOG](CHANGELOG.md).
- As imagens Docker são geradas pela automação [`imagens.yml`](.github/workflows/imagens.yml) e
  publicadas em `ghcr.io/josemoracruvinel`.
- No servidor, a atualização é feita pela tela **Configurações › Atualização do sistema** (ou por
  `bash hostgator-setup-kit/update.sh`, que faz backup antes).

## Tecnologia

Next.js 16 · React 19 · TypeScript · Supabase (Postgres, Auth, Realtime, Storage) · WAHA (WhatsApp)
· Redis · Docker.

## Origem e licença

O Fluxo Care é derivado do projeto de código aberto DeskcommCRM, de Rafael Melgaço, distribuído sob
a licença MIT. É mantido de forma independente desde a versão 1.103.1, sem vínculo com o projeto
original. A licença e o aviso de copyright originais estão em [LICENSE](LICENSE).
