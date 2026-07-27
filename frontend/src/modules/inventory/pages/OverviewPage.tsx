import { useEffect, useState } from "react";
import { Card, Row, Col, Statistic, Spin, Tag, Button, Alert } from "antd";
import { DollarOutlined, WarningOutlined, AlertOutlined, LockOutlined, ShoppingCartOutlined, HistoryOutlined } from "@ant-design/icons";
import { getOverviewKPIs } from "../api";
import { StockOverviewKPIs } from "../types";
import { Link } from "react-router-dom";

export function InventoryOverviewPage() {
  const [kpis, setKpis] = useState<StockOverviewKPIs | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOverviewKPIs()
      .then((data) => setKpis(data))
      .catch((err) => console.error(err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: 50 }}>
        <Spin size="large" tip="Loading Inventory KPIs..." />
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 24, fontSize: 22, fontWeight: 600 }}>Inventory Overview & Analytics</h2>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={6}>
          <Card bordered style={{ background: "linear-gradient(135deg, #1890ff15, #e6f7ff)" }}>
            <Statistic
              title="Total Stock Value"
              value={kpis?.total_stock_value || 0}
              precision={2}
              prefix={<DollarOutlined style={{ color: "#1890ff" }} />}
              suffix="USD"
            />
          </Card>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Card bordered style={{ background: "linear-gradient(135deg, #ff4d4f15, #fff1f0)" }}>
            <Statistic
              title="Items Below Reorder"
              value={kpis?.items_below_reorder || 0}
              valueStyle={{ color: kpis?.items_below_reorder ? "#cf1322" : "#3f8600" }}
              prefix={<WarningOutlined />}
            />
            <Link to="/inventory/replenishment" style={{ marginTop: 8, display: "inline-block" }}>
              View Replenishment &rarr;
            </Link>
          </Card>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Card bordered style={{ background: "linear-gradient(135deg, #faad1415, #fffbe6)" }}>
            <Statistic
              title="Near Expiry (30 / 60 / 90 Days)"
              value={`${kpis?.near_expiry_30_days || 0} / ${kpis?.near_expiry_60_days || 0} / ${kpis?.near_expiry_90_days || 0}`}
              valueStyle={{ color: "#d48806", fontSize: 18 }}
              prefix={<AlertOutlined />}
            />
            <Tag color="volcano" style={{ marginTop: 8 }}>
              {kpis?.near_expiry_30_days || 0} Critical (&le; 30d)
            </Tag>
          </Card>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Card bordered style={{ background: "linear-gradient(135deg, #52c41a15, #f6ffed)" }}>
            <Statistic
              title="Reserved vs Available Qty"
              value={`${kpis?.total_reserved_qty || 0} / ${kpis?.total_available_qty || 0}`}
              valueStyle={{ fontSize: 18 }}
              prefix={<LockOutlined style={{ color: "#52c41a" }} />}
            />
            <div style={{ marginTop: 8, fontSize: 12, color: "#8c8c8c" }}>
              Total On-Hand: {((kpis?.total_reserved_qty || 0) + (kpis?.total_available_qty || 0)).toFixed(2)}
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
        <Col xs={24} md={12}>
          <Card title="Dead Stock Alert (> 60 Days No Movement)" extra={<HistoryOutlined />}>
            <Alert
              message={`${kpis?.dead_stock_count || 0} items have had no stock movement in over 60 days.`}
              type={kpis?.dead_stock_count ? "warning" : "info"}
              showIcon
            />
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card title="Quick Actions">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link to="/inventory/stock-balance">
                <Button type="primary">Stock Balance</Button>
              </Link>
              <Link to="/inventory/stock-ledger">
                <Button>Stock Ledger</Button>
              </Link>
              <Link to="/inventory/replenishment">
                <Button icon={<ShoppingCartOutlined />}>Replenishment</Button>
              </Link>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}

