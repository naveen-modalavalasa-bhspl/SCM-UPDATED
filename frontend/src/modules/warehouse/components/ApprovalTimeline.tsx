// @ts-nocheck
import React from 'react';
import { Timeline, Tag } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ClockCircleFilled,
  MinusCircleFilled,
} from '@ant-design/icons';
import { formatDateTime } from '../utils/helpers';

const statusConfig = {
  approved: {
    color: 'green',
    icon: <CheckCircleFilled style={{ color: '#52c41a' }} />,
    tagColor: 'success',
    label: 'Approved',
  },
  rejected: {
    color: 'red',
    icon: <CloseCircleFilled style={{ color: '#f5222d' }} />,
    tagColor: 'error',
    label: 'Rejected',
  },
  pending: {
    color: 'blue',
    icon: <ClockCircleFilled style={{ color: '#eb2f96' }} />,
    tagColor: 'processing',
    label: 'Pending',
  },
  skipped: {
    color: 'gray',
    icon: <MinusCircleFilled style={{ color: '#8c8c8c' }} />,
    tagColor: 'default',
    label: 'Skipped',
  },
};

const ApprovalTimeline = ({ steps = [] }) => {
  if (!steps || steps.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 24, color: '#bfbfbf' }}>
        No approval steps available
      </div>
    );
  }

  const items = steps.map((step) => {
    const status = (step.status || 'pending').toLowerCase();
    const config = statusConfig[status] || statusConfig.pending;

    return {
      color: config.color,
      dot: config.icon,
      children: (
        <div className={`approval-timeline-step ${status}`}>
          <div className="approval-timeline-step-header">
            <span className="approval-timeline-step-title">
              {step.step_name || step.title || `Step ${step.sequence || ''}`}
            </span>
            <Tag color={config.tagColor}>{config.label}</Tag>
          </div>
          {step.approver_name && (
            <div className="approval-timeline-step-user">
              {step.approver_name}
              {step.role && (
                <span style={{ color: 'rgba(0,0,0,0.35)' }}>
                  {' '}
                  ({step.role})
                </span>
              )}
            </div>
          )}
          {step.action_date && (
            <div className="approval-timeline-step-time">
              {formatDateTime(step.action_date)}
            </div>
          )}
          {step.remarks && (
            <div className="approval-timeline-step-remark">
              &ldquo;{step.remarks}&rdquo;
            </div>
          )}
        </div>
      ),
    };
  });

  return (
    <Timeline className="approval-timeline" items={items} />
  );
};

export default ApprovalTimeline;
