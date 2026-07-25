// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Card, Tag, Spin, Empty, Space, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, NodeIndexOutlined } from '@ant-design/icons';
import api from '../config/api';

const { Text } = Typography;

const TYPE_LABELS = {
  indent: 'Indent', material_request: 'MR', purchase_order: 'PO',
  goods_receipt_note: 'GRN', putaway_order: 'Putaway', material_issue: 'Issue',
  consumption_entry: 'Consumption', invoice: 'Invoice', payment: 'Payment',
  purchase_return: 'Return',
};

const STATUS_COLORS = {
  draft: 'default', pending_approval: 'orange', approved: 'green',
  rejected: 'red', cancelled: 'red', completed: 'blue',
  fulfilled: 'green', partially_fulfilled: 'gold',
  ordered: 'blue', received: 'green', issued: 'green', acknowledged: 'green',
  paid: 'green', overdue: 'red',
};

function DocBadge({ doc }) {
  if (!doc) return null;
  return (
    <Card
      size="small"
      style={{ display: 'inline-block', minWidth: 220, marginRight: 8, marginBottom: 8 }}
    >
      <div style={{ fontSize: 11, color: '#888' }}>{TYPE_LABELS[doc.type] || doc.type}</div>
      <div><Text strong style={{ fontSize: 12 }}>{doc.number || `#${doc.id}`}</Text></div>
      {doc.status && <Tag color={STATUS_COLORS[doc.status] || 'default'} style={{ marginTop: 4 }}>{doc.status}</Tag>}
    </Card>
  );
}

/**
 * Drop-in widget that shows where a doc came from and what it became.
 * Usage:  <DocumentLineage type="indent" id={42} />
 */
export default function DocumentLineage({ type, id, refreshKey }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!type || !id) return;
    setLoading(true);
    api.get(`/lineage/${type}/${id}`)
      .then((r) => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [type, id, refreshKey]);

  if (!type || !id) return null;
  if (loading) return <Card size="small" title={<><NodeIndexOutlined /> Document Lineage</>}><Spin /></Card>;
  if (!data) return null;

  const hasUpstream = (data.upstream || []).length > 0;
  const hasDownstream = (data.downstream || []).length > 0;
  if (!hasUpstream && !hasDownstream) {
    return (
      <Card size="small" title={<><NodeIndexOutlined /> Document Lineage</>}>
        <Empty description="No related documents yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </Card>
    );
  }

  return (
    <Card size="small" title={<><NodeIndexOutlined /> Document Lineage</>}>
      {hasUpstream && (
        <div style={{ marginBottom: 12 }}>
          <Space style={{ marginBottom: 4, color: '#888', fontSize: 12 }}>
            <ArrowUpOutlined /> Source
          </Space>
          <div>{data.upstream.map((d) => <DocBadge key={`u-${d.type}-${d.id}`} doc={d} />)}</div>
        </div>
      )}
      <div style={{ marginBottom: 4 }}>
        <Space style={{ marginBottom: 4 }}>
          <Text strong>{TYPE_LABELS[data.source.type] || data.source.type}: {data.source.number}</Text>
          {data.source.status && <Tag color={STATUS_COLORS[data.source.status] || 'default'}>{data.source.status}</Tag>}
        </Space>
      </div>
      {hasDownstream && (
        <div style={{ marginTop: 12 }}>
          <Space style={{ marginBottom: 4, color: '#888', fontSize: 12 }}>
            <ArrowDownOutlined /> Generated documents
          </Space>
          <div>{data.downstream.map((d) => <DocBadge key={`d-${d.type}-${d.id}`} doc={d} />)}</div>
        </div>
      )}
    </Card>
  );
}
