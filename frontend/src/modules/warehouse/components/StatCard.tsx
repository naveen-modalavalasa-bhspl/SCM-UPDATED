// @ts-nocheck
import React from 'react';
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';

const StatCard = ({
  icon,
  iconColor = '#eb2f96',
  iconBg = '#e6f7ff',
  value,
  label,
  trend,
  trendLabel,
  onClick,
}) => {
  const trendDirection = trend > 0 ? 'up' : trend < 0 ? 'down' : null;

  return (
    <div
      className="stat-card"
      style={onClick ? { cursor: 'pointer' } : undefined}
      onClick={onClick}
    >
      <div className="stat-card-header">
        <div
          className="stat-card-icon"
          style={{ backgroundColor: iconBg, color: iconColor }}
        >
          {icon}
        </div>
        {trendDirection && (
          <div className={`stat-card-trend ${trendDirection}`}>
            {trendDirection === 'up' ? (
              <ArrowUpOutlined />
            ) : (
              <ArrowDownOutlined />
            )}
            {Math.abs(trend)}%
            {trendLabel && (
              <span style={{ color: 'rgba(0,0,0,0.45)', marginLeft: 4 }}>
                {trendLabel}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="stat-card-value">{value}</div>
      <div className="stat-card-label">{label}</div>
    </div>
  );
};

export default StatCard;
