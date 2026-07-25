// @ts-nocheck
import React from 'react';
import { Tag } from 'antd';
import { STATUS_COLORS, STATUS_LABELS } from '../utils/constants';

const StatusTag = ({ status, record, style }) => {
  if (!status) return <Tag color="default">N/A</Tag>;

  const normalized = status.toLowerCase();
  const color = STATUS_COLORS[normalized] || '#8c8c8c';
  let label =
    STATUS_LABELS[normalized] ||
    status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  if (normalized === 'pending_approval' && record) {
    if (record.pending_at === 'oe') {
      label = 'Pending Approval at OE';
    } else if (record.pending_at === 'dm') {
      label = 'Pending Approval DM';
    }
  }

  return (
    <Tag
      style={{
        color: '#fff',
        backgroundColor: color,
        borderColor: color,
        ...style,
      }}
    >
      {label}
    </Tag>
  );
};

export default StatusTag;
